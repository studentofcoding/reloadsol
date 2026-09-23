import type { SwapQuote } from '@/types'
import {
  jupiterApiHeaders,
  throttleJupiterRps,
} from '@/utils/jupiter-rps'
import {
  jupiterV2PriorityFeeQuery,
  type JupiterPrioritizationFeeLamports,
} from '@/utils/priority-fee'

export const JUPITER_SWAP_ORDER_BASE = 'https://api.jup.ag/swap/v2/order'
export const JUPITER_SWAP_EXECUTE_URL = 'https://api.jup.ag/swap/v2/execute'
const JUPITER_SWAP_EXECUTE_TIMEOUT_MS = 30_000

export class JupiterSwapQuoteError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
  ) {
    super(message)
    this.name = 'JupiterSwapQuoteError'
  }
}

export type JupiterBroadcastFeeType = 'maxCap' | 'exactFee'

export type JupiterSwapQuoteParams = {
  inputMint: string
  outputMint: string
  amount: string
  slippageBps: number
  /** When set, `/order` also returns an unsigned swap transaction. */
  taker?: string
  /**
   * Swap V2 fee lamports. Together with `broadcastFeeType=maxCap` this is the
   * cap (Metis v1 `priorityLevelWithMaxLamports` is not on `/order`).
   */
  priorityFeeLamports?: number
  broadcastFeeType?: JupiterBroadcastFeeType
}

export type JupiterQuoteDisplay = {
  inputMint: string
  outputMint: string
  amount: string
  outAmount: string
  minAmountOut: string
  priceImpact: number
  slippageBps: number
  route: unknown
  transaction?: string | null
  lastValidBlockHeight?: number
  requestId?: string
}

export function jupiterSwapOrderSearchParams(
  params: JupiterSwapQuoteParams,
): URLSearchParams {
  const query = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    slippageBps: String(params.slippageBps),
  })
  if (params.taker) query.set('taker', params.taker)
  if (
    params.priorityFeeLamports != null &&
    Number.isFinite(params.priorityFeeLamports) &&
    params.priorityFeeLamports > 0
  ) {
    query.set('priorityFeeLamports', String(Math.round(params.priorityFeeLamports)))
  }
  if (params.broadcastFeeType) query.set('broadcastFeeType', params.broadcastFeeType)
  return query
}

export function buildJupiterSwapQuoteUrl(params: JupiterSwapQuoteParams): string {
  return `${JUPITER_SWAP_ORDER_BASE}?${jupiterSwapOrderSearchParams(params).toString()}`
}

function impactAsFraction(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.abs(raw) <= 1 ? raw : raw / 100
  }
  if (typeof raw === 'string') {
    const n = Number(raw)
    if (Number.isFinite(n)) return Math.abs(n) <= 1 ? n : n / 100
  }
  return 0
}

export function mapJupiterOrderToDisplay(
  body: unknown,
  amountRaw: string,
  slippageBps: number,
): JupiterQuoteDisplay | null {
  if (!body || typeof body !== 'object') return null
  const o = body as Record<string, unknown>
  const outRaw = o.outAmount ?? o.outputAmount
  const outAmount = typeof outRaw === 'number' ? String(Math.trunc(outRaw)) : String(outRaw ?? '')
  if (!/^\d+$/.test(outAmount) || Number(outAmount) <= 0) return null

  const minRaw = o.otherAmountThreshold ?? o.minOutAmount
  const minAmountOut =
    typeof minRaw === 'number'
      ? String(Math.trunc(minRaw))
      : typeof minRaw === 'string' && /^\d+$/.test(minRaw)
        ? minRaw
        : outAmount

  const inputMint = typeof o.inputMint === 'string' ? o.inputMint : ''
  const outputMint = typeof o.outputMint === 'string' ? o.outputMint : ''

  const txRaw = o.transaction ?? o.swapTransaction
  const transaction =
    typeof txRaw === 'string' && txRaw.length > 0 ? txRaw : null

  const heightRaw = o.lastValidBlockHeight
  const lastValidBlockHeight =
    typeof heightRaw === 'number' && Number.isFinite(heightRaw)
      ? heightRaw
      : typeof heightRaw === 'string' && /^\d+$/.test(heightRaw)
        ? Number(heightRaw)
        : undefined

  const requestId = typeof o.requestId === 'string' && o.requestId.length > 0
    ? o.requestId
    : undefined

  return {
    inputMint,
    outputMint,
    amount: amountRaw,
    outAmount,
    minAmountOut,
    priceImpact: impactAsFraction(o.priceImpactPct ?? o.priceImpact),
    slippageBps,
    route: body,
    transaction,
    lastValidBlockHeight,
    requestId,
  }
}

export function mapJupiterSwapDisplayToSwapQuote(
  display: JupiterQuoteDisplay,
): SwapQuote {
  const body = display.route
  const routePlan =
    body &&
    typeof body === 'object' &&
    Array.isArray((body as { routePlan?: unknown }).routePlan)
      ? ((body as { routePlan: unknown[] }).routePlan)
      : []

  return {
    inputMint: display.inputMint,
    outputMint: display.outputMint,
    inAmount: display.amount,
    outAmount: display.outAmount,
    otherAmountThreshold: display.minAmountOut,
    swapMode: 'ExactIn',
    slippageBps: display.slippageBps,
    priceImpactPct: String(display.priceImpact ?? 0),
    routePlan,
  }
}

function getClientBaseUrl(): string {
  if (typeof window !== 'undefined') return ''
  return (
    process.env.API_HOST ||
    process.env.NEXT_PUBLIC_API_HOST ||
    'http://localhost:3000'
  )
}

/** Client-side: proxied GET `/api/jupiter/quote`. */
export async function fetchJupiterSwapQuote(
  params: JupiterSwapQuoteParams,
): Promise<JupiterQuoteDisplay> {
  const query = jupiterSwapOrderSearchParams(params)

  const response = await fetch(`${getClientBaseUrl()}/api/jupiter/quote?${query.toString()}`)
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { error: text.slice(0, 180) }
  }

  if (!response.ok) {
    const err =
      body && typeof body === 'object'
        ? (body as { error?: string; errorMessage?: string })
        : {}
    throw new JupiterSwapQuoteError(
      err.errorMessage || err.error || `Jupiter quote HTTP ${response.status}`,
      response.status,
    )
  }

  if (body && typeof body === 'object' && 'outAmount' in body) {
    const mapped = body as JupiterQuoteDisplay
    if (/^\d+$/.test(mapped.outAmount) && Number(mapped.outAmount) > 0) {
      return mapped
    }
  }

  const mapped = mapJupiterOrderToDisplay(body, params.amount, params.slippageBps)
  if (!mapped) {
    throw new JupiterSwapQuoteError('Jupiter quote missing outAmount', 502)
  }
  return mapped
}

export async function fetchJupiterSwapQuoteDirect(
  params: JupiterSwapQuoteParams,
): Promise<JupiterQuoteDisplay> {
  const key = process.env.JUPITER_API_KEY?.trim()
  if (!key) {
    throw new JupiterSwapQuoteError('JUPITER_API_KEY is not set', 503)
  }

  await throttleJupiterRps()
  const url = buildJupiterSwapQuoteUrl(params)
  const response = await fetch(url, { headers: jupiterApiHeaders() })
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { error: text.slice(0, 180) }
  }

  if (response.status === 429) {
    throw new JupiterSwapQuoteError('Jupiter quote rate limited', 429)
  }
  if (!response.ok) {
    const err = body && typeof body === 'object' ? (body as { error?: string; errorMessage?: string }) : {}
    throw new JupiterSwapQuoteError(
      err.errorMessage || err.error || `Jupiter quote HTTP ${response.status}`,
      response.status,
    )
  }

  const mapped = mapJupiterOrderToDisplay(body, params.amount, params.slippageBps)
  if (!mapped) {
    throw new JupiterSwapQuoteError('Jupiter quote missing outAmount', 502)
  }
  return mapped
}

export type JupiterSwapPrepared = {
  swapTransaction: string
  outAmount: string
  lastValidBlockHeight?: number
  requestId?: string
  /** Raw impact from `/order` (fraction or percent). Gate with `impactToAbsPct`. */
  priceImpact?: number
}

export type JupiterSwapExecuteParams = {
  signedTransaction: string
  requestId: string
}

export type JupiterExecuteOutcome = {
  signature: string
  outputAmountResult?: string
}

function amountField(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return String(Math.trunc(value))
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  return undefined
}

/** Signature from a successful `/execute` body, or throws so the caller can fall back. */
export function jupiterExecuteSignature(body: unknown): string {
  if (!body || typeof body !== 'object') {
    throw new JupiterSwapQuoteError('Jupiter execute returned an empty body', 502)
  }
  const o = body as Record<string, unknown>
  const status = typeof o.status === 'string' ? o.status : ''
  const signature = typeof o.signature === 'string' ? o.signature : ''
  const code = typeof o.code === 'number' ? o.code : undefined
  const errorText =
    typeof o.error === 'string'
      ? o.error
      : typeof o.errorMessage === 'string'
        ? o.errorMessage
        : ''
  if (status === 'Success' && signature.length > 0 && (code == null || code === 0)) {
    return signature
  }
  throw new JupiterSwapQuoteError(
    errorText || `Jupiter execute ${status || 'failed'}`,
    502,
  )
}

/** Code 0 / Success means Jupiter already confirmed the landing. */
export function jupiterExecuteOutcome(body: unknown): JupiterExecuteOutcome {
  const signature = jupiterExecuteSignature(body)
  const o = body as Record<string, unknown>
  return {
    signature,
    outputAmountResult: amountField(o.outputAmountResult ?? o.totalOutputAmount),
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return { error: text.slice(0, 180) }
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback
  const err = body as { error?: string; errorMessage?: string }
  return err.errorMessage || err.error || fallback
}

async function postJupiterExecute(
  url: string,
  params: JupiterSwapExecuteParams,
  headers: Record<string, string>,
): Promise<JupiterExecuteOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), JUPITER_SWAP_EXECUTE_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        signedTransaction: params.signedTransaction,
        requestId: params.requestId,
      }),
      signal: controller.signal,
    })
    const body = await readResponseBody(response)
    if (response.status === 429) {
      throw new JupiterSwapQuoteError('Jupiter execute rate limited', 429)
    }
    if (!response.ok) {
      throw new JupiterSwapQuoteError(
        errorMessage(body, `Jupiter execute HTTP ${response.status}`),
        response.status,
      )
    }
    return jupiterExecuteOutcome(body)
  } catch (error) {
    if (error instanceof JupiterSwapQuoteError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new JupiterSwapQuoteError(
        `Jupiter execute timed out after ${JUPITER_SWAP_EXECUTE_TIMEOUT_MS}ms`,
        504,
      )
    }
    throw new JupiterSwapQuoteError(
      error instanceof Error ? error.message : 'Unknown Jupiter execute error',
    )
  } finally {
    clearTimeout(timer)
  }
}

/** Server-side managed landing. Key stays in `jupiterApiHeaders`. */
export async function executeJupiterSwapDirect(
  params: JupiterSwapExecuteParams,
): Promise<JupiterExecuteOutcome> {
  const key = process.env.JUPITER_API_KEY?.trim()
  if (!key) {
    throw new JupiterSwapQuoteError('JUPITER_API_KEY is not set', 503)
  }
  await throttleJupiterRps()
  return postJupiterExecute(JUPITER_SWAP_EXECUTE_URL, params, {
    ...jupiterApiHeaders(),
    'Content-Type': 'application/json',
  })
}

/** Client-side: proxied POST `/api/jupiter/execute`. */
export async function executeJupiterSwap(
  params: JupiterSwapExecuteParams,
): Promise<JupiterExecuteOutcome> {
  return postJupiterExecute(
    `${getClientBaseUrl()}/api/jupiter/execute`,
    params,
    {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  )
}

/** `/order` with `taker` — one round trip for quote, unsigned tx, and requestId. */
export async function prepareJupiterSwapOrder(params: {
  userPublicKey: string
  inputMint: string
  outputMint: string
  amount: string | number
  slippageBps: number
  priorityFeeLamports?: JupiterPrioritizationFeeLamports
  direct?: boolean
}): Promise<JupiterSwapPrepared> {
  const v2Fee = jupiterV2PriorityFeeQuery(params.priorityFeeLamports)
  const orderParams: JupiterSwapQuoteParams = {
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: String(params.amount),
    slippageBps: params.slippageBps,
    taker: params.userPublicKey,
    priorityFeeLamports: v2Fee.priorityFeeLamports,
    broadcastFeeType: v2Fee.broadcastFeeType,
  }
  const useDirect = params.direct ?? typeof window === 'undefined'
  const order = useDirect
    ? await fetchJupiterSwapQuoteDirect(orderParams)
    : await fetchJupiterSwapQuote(orderParams)
  if (!order.transaction) {
    throw new JupiterSwapQuoteError(
      'Jupiter Swap order returned no transaction',
      502,
    )
  }
  return {
    swapTransaction: order.transaction,
    outAmount: order.outAmount,
    lastValidBlockHeight: order.lastValidBlockHeight,
    requestId: order.requestId,
    priceImpact: order.priceImpact,
  }
}
