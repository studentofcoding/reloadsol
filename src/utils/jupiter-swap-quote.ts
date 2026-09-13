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
}

export function buildJupiterSwapQuoteUrl(params: JupiterSwapQuoteParams): string {
  const query = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    slippageBps: String(params.slippageBps),
  })
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

  return {
    inputMint,
    outputMint,
    amount: amountRaw,
    outAmount,
    minAmountOut,
    priceImpact: impactAsFraction(o.priceImpactPct ?? o.priceImpact),
    slippageBps,
    route: body,
  }
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
