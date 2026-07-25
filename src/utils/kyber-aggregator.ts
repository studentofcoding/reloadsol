/**
 * KyberSwap Aggregator V1 helpers for Robinhood Chain.
 * Browser calls go through /api/kyber/* proxies (X-Client-Id server-side).
 */

import { RH_USDG, RH_USDG_DECIMALS, RH_WETH } from '@/utils/dlmm/rh-univ2'

export const KYBER_API_BASE = 'https://aggregator-api.kyberswap.com'
export const KYBER_CHAIN = 'robinhood'
/** Native ETH sentinel used by Kyber Aggregator. */
export const KYBER_NATIVE =
  '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as const

export type KyberQuoteCurrency = 'ETH' | 'USDG' | 'WETH'

export type KyberRouteSummary = Record<string, unknown>

export type KyberRouteResult = {
  routeSummary: KyberRouteSummary
  routerAddress: string
  amountIn: string
  amountOut?: string
}

export type KyberBuildResult = {
  data: `0x${string}`
  routerAddress: string
  amountIn: string
  amountOut?: string
  /** Native value to attach when tokenIn is ETH. */
  valueWei: bigint
}

export function isKyberNative(addr: string): boolean {
  return addr.trim().toLowerCase() === KYBER_NATIVE.toLowerCase()
}

export function kyberQuoteTokenAddress(quote: KyberQuoteCurrency): string {
  if (quote === 'USDG') return RH_USDG
  if (quote === 'WETH') return RH_WETH
  return KYBER_NATIVE
}

export function kyberQuoteDecimals(quote: KyberQuoteCurrency): number {
  return quote === 'USDG' ? RH_USDG_DECIMALS : 18
}

/** Human amount → wei string for Kyber amountIn. */
export function toKyberAmountRaw(
  humanAmount: number,
  decimals: number,
): string {
  if (!Number.isFinite(humanAmount) || humanAmount <= 0) {
    throw new Error('Amount must be a positive number')
  }
  const [whole, frac = ''] = humanAmount.toFixed(decimals).split('.')
  const raw = `${whole}${frac.padEnd(decimals, '0').slice(0, decimals)}`.replace(
    /^0+(?=\d)/,
    '',
  )
  return raw || '0'
}

function kyberHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  const clientId = process.env.KYBER_CLIENT_ID?.trim()
  if (clientId) headers['X-Client-Id'] = clientId
  return headers
}

export async function fetchKyberRoute(params: {
  tokenIn: string
  tokenOut: string
  amountIn: string
  gasInclude?: boolean
}): Promise<KyberRouteResult> {
  const q = new URLSearchParams({
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: params.amountIn,
  })
  if (params.gasInclude != null) {
    q.set('gasInclude', String(params.gasInclude))
  }
  const url = `${KYBER_API_BASE}/${KYBER_CHAIN}/api/v1/routes?${q}`
  const res = await fetch(url, { headers: kyberHeaders(), cache: 'no-store' })
  const json = (await res.json()) as {
    code?: number
    message?: string
    data?: {
      routeSummary?: KyberRouteSummary
      routerAddress?: string
    }
  }
  if (!res.ok || json.code !== 0 || !json.data?.routeSummary) {
    throw new Error(json.message || `Kyber routes failed (${res.status})`)
  }
  const routeSummary = json.data.routeSummary
  const amountIn = String(
    (routeSummary as { amountIn?: string }).amountIn ?? params.amountIn,
  )
  const amountOut = (routeSummary as { amountOut?: string }).amountOut
  return {
    routeSummary,
    routerAddress: String(json.data.routerAddress ?? ''),
    amountIn,
    amountOut: amountOut != null ? String(amountOut) : undefined,
  }
}

export async function buildKyberRoute(params: {
  routeSummary: KyberRouteSummary
  sender: string
  recipient: string
  /** Slippage in bips (100 = 1%). */
  slippageTolerance: number
}): Promise<KyberBuildResult> {
  const url = `${KYBER_API_BASE}/${KYBER_CHAIN}/api/v1/route/build`
  const res = await fetch(url, {
    method: 'POST',
    headers: kyberHeaders(),
    cache: 'no-store',
    body: JSON.stringify({
      routeSummary: params.routeSummary,
      sender: params.sender,
      recipient: params.recipient,
      slippageTolerance: Math.max(
        1,
        Math.min(5000, Math.round(params.slippageTolerance)),
      ),
    }),
  })
  const json = (await res.json()) as {
    code?: number
    message?: string
    data?: {
      data?: string
      routerAddress?: string
      amountIn?: string
      amountOut?: string
    }
  }
  if (!res.ok || json.code !== 0 || !json.data?.data) {
    throw new Error(json.message || `Kyber build failed (${res.status})`)
  }
  const amountIn = String(json.data.amountIn ?? '0')
  const tokenIn = String(
    (params.routeSummary as { tokenIn?: string }).tokenIn ?? '',
  )
  const valueWei = isKyberNative(tokenIn) ? BigInt(amountIn) : BigInt(0)
  const data = json.data.data as `0x${string}`
  if (!data.startsWith('0x')) {
    throw new Error('Kyber build returned invalid calldata')
  }
  return {
    data,
    routerAddress: String(json.data.routerAddress ?? ''),
    amountIn,
    amountOut:
      json.data.amountOut != null ? String(json.data.amountOut) : undefined,
    valueWei,
  }
}

/** Browser → our proxy (routes). */
export async function clientKyberRoute(params: {
  tokenIn: string
  tokenOut: string
  amountIn: string
}): Promise<KyberRouteResult> {
  const q = new URLSearchParams({
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: params.amountIn,
  })
  const res = await fetch(`/api/kyber/routes?${q}`)
  const json = (await res.json()) as {
    success?: boolean
    error?: string
    route?: KyberRouteResult
  }
  if (!res.ok || !json.success || !json.route) {
    throw new Error(json.error || `Kyber routes proxy failed (${res.status})`)
  }
  return json.route
}

/** Browser → our proxy (build). */
export async function clientKyberBuild(params: {
  routeSummary: KyberRouteSummary
  sender: string
  recipient: string
  slippageTolerance: number
}): Promise<KyberBuildResult> {
  const res = await fetch('/api/kyber/build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  const json = (await res.json()) as {
    success?: boolean
    error?: string
    build?: {
      data: `0x${string}`
      routerAddress: string
      amountIn: string
      amountOut?: string
      valueWei: string
    }
  }
  if (!res.ok || !json.success || !json.build) {
    throw new Error(json.error || `Kyber build proxy failed (${res.status})`)
  }
  return {
    data: json.build.data,
    routerAddress: json.build.routerAddress,
    amountIn: json.build.amountIn,
    amountOut: json.build.amountOut,
    valueWei: BigInt(json.build.valueWei),
  }
}
