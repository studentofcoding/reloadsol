/**
 * Pre-trade simulation for Robinhood: from $, to $, price impact.
 * Parent = Kyber route; Bound = GMGN trade quote.
 */

import type { RhSwapQuote } from '@/utils/dlmm/rh-univ2-swap'
import { RH_USDG, RH_WETH } from '@/utils/dlmm/rh-univ2'
import {
  GMGN_NATIVE_ETH,
  GMGN_RH_USDG,
  GMGN_RH_WETH,
  gmgnTokenDecimals,
  toGmgnRawAmount,
  slippageBpsToGmgnPercent,
} from '@/utils/gmgn-currencies'
import {
  clientKyberRoute,
  kyberQuoteDecimals,
  kyberQuoteTokenAddress,
  toKyberAmountRaw,
  KYBER_NATIVE,
} from '@/utils/kyber-aggregator'

export type RhTradeSimLeg = {
  fromUsd: number | null
  toUsd: number | null
  priceImpactPct: number | null
  amountOutHuman: number | null
  amountOutRaw: string | null
  /** Human/raw units of the input side (quote spent on buys, token sold on sells). */
  amountInHuman: number | null
  amountInRaw: string | null
}

export function quoteCurrencyUsdPerUnit(
  quote: RhSwapQuote,
  ethUsd: number,
): number {
  if (quote === 'USDG') return 1
  return ethUsd > 0 ? ethUsd : 0
}

/** Impact % from USD notionals: (from - to) / from * 100. */
export function computePriceImpactPct(
  fromUsd: number,
  toUsd: number,
): number | null {
  if (!(fromUsd > 0) || !Number.isFinite(toUsd)) return null
  return ((fromUsd - toUsd) / fromUsd) * 100
}

export function rawAmountToHuman(raw: string, decimals: number): number {
  const s = raw.trim()
  if (!/^\d+$/.test(s)) return 0
  if (decimals <= 0) return Number(s)
  const padded = s.padStart(decimals + 1, '0')
  const whole = padded.slice(0, -decimals)
  const frac = padded.slice(-decimals)
  return Number(`${whole}.${frac}`)
}

function numField(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim()) {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
  }
  return null
}

export async function fetchEthUsdSpot(): Promise<number> {
  try {
    const res = await fetch(
      'https://api.coinbase.com/v2/prices/ETH-USD/spot',
      { cache: 'no-store' },
    )
    const json = (await res.json()) as { data?: { amount?: string } }
    const n = Number(json.data?.amount)
    if (Number.isFinite(n) && n > 0) return n
  } catch {
    /* fall through */
  }
  return 0
}

async function fetchTokenUsd(address: string): Promise<number | null> {
  try {
    const q = new URLSearchParams({
      chain: 'robinhood',
      address,
    })
    const res = await fetch(`/api/gmgn/token-snapshot?${q}`)
    const json = (await res.json()) as Record<string, unknown>
    const price = numField(json, ['price_usd', 'usd_price', 'price'])
    return price != null && price > 0 ? price : null
  } catch {
    return null
  }
}

function impactFromRouteSummary(
  summary: Record<string, unknown>,
): number | null {
  const raw = numField(summary, [
    'priceImpact',
    'priceImpactPct',
    'price_impact',
    'price_impact_pct',
  ])
  if (raw == null) return null
  // Kyber may send fraction (0.012) or percent (1.2)
  return Math.abs(raw) <= 1 ? raw * 100 : raw
}

function gmgnQuoteToken(quote: RhSwapQuote): string {
  if (quote === 'USDG') return GMGN_RH_USDG
  if (quote === 'WETH') return GMGN_RH_WETH
  return GMGN_NATIVE_ETH
}

function isQuoteSideToken(addr: string): boolean {
  const a = addr.trim().toLowerCase()
  return (
    a === RH_USDG.toLowerCase() ||
    a === RH_WETH.toLowerCase() ||
    a === KYBER_NATIVE.toLowerCase() ||
    a === GMGN_NATIVE_ETH.toLowerCase() ||
    a === GMGN_RH_USDG.toLowerCase() ||
    a === GMGN_RH_WETH.toLowerCase()
  )
}

export async function simulateRhParentBuyLeg(params: {
  amountHuman: number
  tokenAddress: string
  quote: RhSwapQuote
  ethUsd: number
  tokenDecimals?: number
}): Promise<RhTradeSimLeg> {
  const tokenIn = kyberQuoteTokenAddress(params.quote)
  const decimals = kyberQuoteDecimals(params.quote)
  const amountIn = toKyberAmountRaw(params.amountHuman, decimals)
  const route = await clientKyberRoute({
    tokenIn,
    tokenOut: params.tokenAddress,
    amountIn,
  })
  const fromUsd =
    params.amountHuman * quoteCurrencyUsdPerUnit(params.quote, params.ethUsd)
  const outRaw = route.amountOut ?? null
  const tokenDec = params.tokenDecimals ?? 18
  const outHuman =
    outRaw != null ? rawAmountToHuman(outRaw, tokenDec) : null
  let toUsd: number | null = null
  const summary = route.routeSummary as Record<string, unknown>
  const apiInUsd = numField(summary, ['amountInUsd', 'amount_in_usd'])
  const apiOutUsd = numField(summary, ['amountOutUsd', 'amount_out_usd'])
  if (apiOutUsd != null) toUsd = apiOutUsd
  else if (outRaw != null) {
    const tokenUsd = await fetchTokenUsd(params.tokenAddress)
    const human = rawAmountToHuman(outRaw, tokenDec)
    if (tokenUsd != null) toUsd = human * tokenUsd
  }
  const impact =
    impactFromRouteSummary(summary) ??
    (apiInUsd != null && toUsd != null
      ? computePriceImpactPct(apiInUsd, toUsd)
      : computePriceImpactPct(fromUsd, toUsd ?? 0))
  return {
    fromUsd: fromUsd > 0 ? fromUsd : apiInUsd,
    toUsd,
    priceImpactPct: impact,
    amountOutHuman: outHuman,
    amountOutRaw: outRaw,
    amountInHuman: params.amountHuman,
    amountInRaw: amountIn,
  }
}

export async function simulateRhBoundBuyLeg(params: {
  from: string
  amountHuman: number
  tokenAddress: string
  quote: RhSwapQuote
  slippageBps: number
  ethUsd: number
  tokenDecimals?: number
}): Promise<RhTradeSimLeg> {
  const inputToken = gmgnQuoteToken(params.quote)
  const decimals = gmgnTokenDecimals('robinhood', inputToken)
  const amount = toGmgnRawAmount(params.amountHuman, decimals)
  const res = await fetch('/api/gmgn/trade/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chain: 'robinhood',
      from: params.from,
      inputToken,
      outputToken: params.tokenAddress,
      amount,
      slippage: slippageBpsToGmgnPercent(params.slippageBps),
    }),
  })
  const json = (await res.json()) as {
    success?: boolean
    quote?: Record<string, unknown>
    error?: string
  }
  if (!res.ok || !json.success || !json.quote) {
    throw new Error(json.error || 'GMGN quote failed')
  }
  const q = json.quote
  const outRaw =
    typeof q.output_amount === 'string'
      ? q.output_amount
      : q.output_amount != null
        ? String(q.output_amount)
        : null
  const fromUsd =
    params.amountHuman * quoteCurrencyUsdPerUnit(params.quote, params.ethUsd)
  let toUsd = numField(q, ['to_usd', 'amount_out_usd', 'output_usd'])
  const impactApi = numField(q, [
    'price_impact',
    'priceImpact',
    'price_impact_pct',
  ])
  const tokenDec = params.tokenDecimals ?? 18
  if (toUsd == null && outRaw) {
    const tokenUsd = await fetchTokenUsd(params.tokenAddress)
    const human = rawAmountToHuman(outRaw, tokenDec)
    if (tokenUsd != null) toUsd = human * tokenUsd
  }
  return {
    fromUsd: fromUsd > 0 ? fromUsd : null,
    toUsd,
    priceImpactPct:
      impactApi != null
        ? Math.abs(impactApi) <= 1
          ? impactApi * 100
          : impactApi
        : toUsd != null
          ? computePriceImpactPct(fromUsd, toUsd)
          : null,
    amountOutHuman: outRaw != null ? rawAmountToHuman(outRaw, tokenDec) : null,
    amountOutRaw: outRaw,
    amountInHuman: params.amountHuman,
    amountInRaw: amount,
  }
}

export async function simulateRhParentSellLeg(params: {
  publicClient: {
    readContract: (args: {
      address: `0x${string}`
      abi: readonly unknown[]
      functionName: string
      args: unknown[]
    }) => Promise<unknown>
  }
  account: `0x${string}`
  tokenAddress: string
  percent: number
  quote: RhSwapQuote
  ethUsd: number
  tokenDecimals?: number
}): Promise<RhTradeSimLeg> {
  const { erc20Abi } = await import('@/utils/dlmm/rh-univ2')
  const bal = (await params.publicClient.readContract({
    address: params.tokenAddress as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [params.account],
  })) as bigint
  const amountIn =
    (bal * BigInt(Math.floor(params.percent * 100))) / BigInt(10_000)
  if (amountIn <= BigInt(0)) {
    throw new Error('No token balance to sell')
  }
  const tokenOut = kyberQuoteTokenAddress(params.quote)
  const route = await clientKyberRoute({
    tokenIn: params.tokenAddress,
    tokenOut,
    amountIn: amountIn.toString(),
  })
  const dec = params.tokenDecimals ?? 18
  const inHuman = rawAmountToHuman(amountIn.toString(), dec)
  const tokenUsd = await fetchTokenUsd(params.tokenAddress)
  const fromUsd =
    tokenUsd != null ? inHuman * tokenUsd : null
  const outRaw = route.amountOut ?? null
  const outDec = kyberQuoteDecimals(params.quote)
  const outHuman =
    outRaw != null ? rawAmountToHuman(outRaw, outDec) : null
  const toUsd =
    outHuman != null
      ? outHuman * quoteCurrencyUsdPerUnit(params.quote, params.ethUsd)
      : null
  const summary = route.routeSummary as Record<string, unknown>
  const impact =
    impactFromRouteSummary(summary) ??
    (fromUsd != null && toUsd != null
      ? computePriceImpactPct(fromUsd, toUsd)
      : null)
  return {
    fromUsd,
    toUsd,
    priceImpactPct: impact,
    amountOutHuman: outHuman,
    amountOutRaw: outRaw,
    amountInHuman: inHuman,
    amountInRaw: amountIn.toString(),
  }
}

export async function simulateRhBoundSellLeg(params: {
  from: string
  tokenAddress: string
  percent: number
  quote: RhSwapQuote
  slippageBps: number
  ethUsd: number
  /** Raw amount already computed by caller (preferred). */
  amountRaw?: string
  tokenDecimals?: number
}): Promise<RhTradeSimLeg> {
  const outputToken = gmgnQuoteToken(params.quote)
  const amount = params.amountRaw ?? '0'
  if (!amount || amount === '0') {
    throw new Error('Sell amount required for sim')
  }
  const res = await fetch('/api/gmgn/trade/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chain: 'robinhood',
      from: params.from,
      inputToken: params.tokenAddress,
      outputToken,
      amount,
      slippage: slippageBpsToGmgnPercent(params.slippageBps),
    }),
  })
  const json = (await res.json()) as {
    success?: boolean
    quote?: Record<string, unknown>
    error?: string
  }
  if (!res.ok || !json.success || !json.quote) {
    throw new Error(json.error || 'GMGN sell quote failed')
  }
  const q = json.quote
  const outRaw =
    typeof q.output_amount === 'string'
      ? q.output_amount
      : q.output_amount != null
        ? String(q.output_amount)
        : null
  const outDec = gmgnTokenDecimals('robinhood', outputToken)
  const outHuman =
    outRaw != null ? rawAmountToHuman(outRaw, outDec) : null
  const toUsd =
    outHuman != null
      ? outHuman * quoteCurrencyUsdPerUnit(params.quote, params.ethUsd)
      : numField(q, ['to_usd', 'amount_out_usd'])
  const inHuman = rawAmountToHuman(amount, params.tokenDecimals ?? 18)
  const tokenUsd = await fetchTokenUsd(params.tokenAddress)
  const fromUsd = tokenUsd != null ? inHuman * tokenUsd : null
  const impactApi = numField(q, ['price_impact', 'priceImpact'])
  return {
    fromUsd,
    toUsd: toUsd ?? null,
    priceImpactPct:
      impactApi != null
        ? Math.abs(impactApi) <= 1
          ? impactApi * 100
          : impactApi
        : fromUsd != null && toUsd != null
          ? computePriceImpactPct(fromUsd, toUsd)
          : null,
    amountOutHuman: outHuman,
    amountOutRaw: outRaw,
    amountInHuman: inHuman,
    amountInRaw: amount,
  }
}

/** Unused helper kept for call sites that need quote-side detection. */
export function rhSimIsQuoteToken(addr: string): boolean {
  return isQuoteSideToken(addr)
}
