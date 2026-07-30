/**
 * Builders for enriched Robinhood trade records.
 *
 * RH buys used to store only the spent quote amount; RH sells stored nothing
 * financial at all. That broke both the history display (a buy showed the
 * spent ETH instead of the bought token) and the PnL cycle matcher (sells
 * were skipped, cycles never closed). These helpers produce per-token
 * records carrying tokenAmount / priceUsd / quote amounts so both work.
 */

import type { TrackingRecord } from '@/utils/trading-tracker'
import { rawAmountToHuman } from '@/utils/rh-trade-sim'

export type RhQuoteLike = 'ETH' | 'USDG' | 'WETH' | (string & {})

type TrackedToken = TrackingRecord['tokens'][number]

/** USD value of one unit of the RH quote currency (USDG is a stablecoin). */
export function rhQuoteUsdPerUnit(quote: RhQuoteLike, ethUsd: number): number {
  return quote === 'USDG' ? 1 : ethUsd > 0 ? ethUsd : 0
}

/** Per-token record for a RH buy (quote currency → token). */
export function buildRhBuyToken(params: {
  mintAddress: string
  symbol?: string
  /** Human units of quote currency spent (ETH/USDG/WETH). */
  spentQuote: number
  /** USD per unit of the quote currency (see rhQuoteUsdPerUnit). */
  usdPerUnit: number
  /** Raw token amount out from the quote/simulation, if known. */
  estOutRaw?: string | null
  /** Token decimals (default 18 — RH meme convention). */
  tokenDecimals?: number
}): { token: TrackedToken; usdValue: number } {
  const usdValue =
    params.spentQuote > 0 && params.usdPerUnit > 0
      ? params.spentQuote * params.usdPerUnit
      : 0
  const tokenAmount =
    params.estOutRaw != null
      ? rawAmountToHuman(params.estOutRaw, params.tokenDecimals ?? 18)
      : 0
  const priceUsd =
    tokenAmount > 0 && usdValue > 0 ? usdValue / tokenAmount : undefined

  return {
    token: {
      mintAddress: params.mintAddress,
      symbol: params.symbol,
      tokenAmount: tokenAmount > 0 ? tokenAmount : undefined,
      priceUsd,
      solAmount: params.spentQuote > 0 ? params.spentQuote : undefined,
      solPrice: params.usdPerUnit > 0 ? params.usdPerUnit : undefined,
    },
    usdValue,
  }
}

/** Per-token record for a RH sell (token → quote currency). */
export function buildRhSellToken(params: {
  mintAddress: string
  symbol?: string
  /** Human units of the token sold, if known. */
  soldTokenAmount?: number
  /** Token USD price at sell time, if known. */
  tokenPriceUsd?: number
  /** Human units of quote currency received, if known. */
  receivedQuote?: number
  /** USD per unit of the quote currency. */
  usdPerUnit: number
}): { token: TrackedToken; usdValue: number } {
  const received = params.receivedQuote ?? 0
  let usdValue =
    received > 0 && params.usdPerUnit > 0 ? received * params.usdPerUnit : 0
  if (usdValue <= 0 && params.soldTokenAmount && params.tokenPriceUsd) {
    usdValue = params.soldTokenAmount * params.tokenPriceUsd
  }
  const priceUsd =
    params.tokenPriceUsd ??
    (params.soldTokenAmount && params.soldTokenAmount > 0 && usdValue > 0
      ? usdValue / params.soldTokenAmount
      : undefined)

  return {
    token: {
      mintAddress: params.mintAddress,
      symbol: params.symbol,
      tokenAmount:
        params.soldTokenAmount && params.soldTokenAmount > 0
          ? params.soldTokenAmount
          : undefined,
      priceUsd,
      solAmount: received > 0 ? received : undefined,
      solPrice: params.usdPerUnit > 0 ? params.usdPerUnit : undefined,
    },
    usdValue,
  }
}
