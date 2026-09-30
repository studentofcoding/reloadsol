import type { TrackingRecord } from '@/utils/trading-tracker'
import { computeOpenTradeCycle } from '@/utils/simulation-trades'
import { TOKENS } from '@/utils/solana'

const DUST_UI = 0.000001
const QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  TOKENS.USDC,
  TOKENS.USDT,
])

export type OpenBarHolding = {
  balanceRaw: number
  uiAmount: number
  decimals: number
  symbol?: string
  logoURI?: string
}

export type OpenBarPosition = {
  mintAddress: string
  symbol: string
  logoURI: string | null
  buyPriceUsd: number
  balanceRaw: number
  uiAmount: number
  decimals: number
}

/**
 * Real (non-sim) opens that are still in the wallet, with frozen cost basis
 * from the live trade cycle — watchlist-style marks use buyPriceUsd vs spot.
 *
 * A wallet hold with **no live buy record is not a position** and is not returned. That fallback
 * used to render the last such hold, which is how an airdropped clone sharing a real token's ticker
 * ("2 STONK") ended up looking like a position beside the real one. The caller additionally hides
 * unpriced positions, since a clone is typically unpriced while a real hold is not.
 */
export function listLiveOpenBarPositions(
  records: TrackingRecord[],
  holdingsByMint: Map<string, OpenBarHolding>,
): OpenBarPosition[] {
  const out: OpenBarPosition[] = []

  for (const [mint, holding] of holdingsByMint) {
    if (holding.uiAmount <= DUST_UI || holding.balanceRaw <= 0) continue
    if (QUOTE_MINTS.has(mint)) continue
    const cycle = computeOpenTradeCycle(records, mint, 'live')
    if (!cycle || cycle.weightedBuyPriceUsd <= 0) continue

    out.push({
      mintAddress: mint,
      symbol: holding.symbol || cycle.symbol || mint.slice(0, 6),
      logoURI: holding.logoURI || cycle.logoURI || null,
      buyPriceUsd: cycle.weightedBuyPriceUsd,
      balanceRaw: holding.balanceRaw,
      uiAmount: holding.uiAmount,
      decimals: holding.decimals,
    })
  }

  return out
}
