import type { SwapQuote } from '@/types'
import {
  jupiterApiHeaders,
  throttleJupiterRps,
} from '@/utils/jupiter-rps'

export const JUPITER_SWAP_ORDER_BASE = 'https://api.jup.ag/swap/v2/order'

export class JupiterSwapQuoteError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
  ) {
    super(message)
    this.name = 'JupiterSwapQuoteError'
  }
}

export type JupiterSwapQuoteParams = {
  inputMint: string
  outputMint: string
  amount: string
  slippageBps: number
  /** When set, `/order` also returns an unsigned swap transaction. */
  taker?: string
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

export function buildJupiterSwapQuoteUrl(params: JupiterSwapQuoteParams): string {
  const query = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    slippageBps: String(params.slippageBps),
  })
  if (params.taker) query.set('taker', params.taker)
  return `${JUPITER_SWAP_ORDER_BASE}?${query.toString()}`
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
  const query = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    slippageBps: String(params.slippageBps),
  })
  if (params.taker) query.set('taker', params.taker)

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
}

/** `/order` with `taker` — unsigned v0 tx (send via existing RPC/Shyft path). */
export async function prepareJupiterSwapOrder(params: {
  userPublicKey: string
  inputMint: string
  outputMint: string
  amount: string | number
  slippageBps: number
  direct?: boolean
}): Promise<JupiterSwapPrepared> {
  const orderParams: JupiterSwapQuoteParams = {
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: String(params.amount),
    slippageBps: params.slippageBps,
    taker: params.userPublicKey,
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
  }
}
