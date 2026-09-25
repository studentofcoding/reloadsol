/**
 * Discovery-feed adapter for the trending bot.
 *
 * `TRENDING_FEED=gmgn` makes the Sol cycle read the same GMGN market-rank
 * snapshot the UI list uses (one cached call per 5 min, shared + inflight
 * deduped). GMGN rows are adapted into the Jupiter pool shape the existing
 * filter → assign → buy pipeline already consumes, so that pipeline is reused
 * unchanged instead of forked.
 */

import type { GmgnFilteredTrendingToken } from '@/utils/gmgn-trending-filtered'

/** Discovery feed selector. Defaults to the legacy Jupiter list. */
export function trendingFeedIsGmgn(): boolean {
  return (process.env.TRENDING_FEED || 'jupiter').trim().toLowerCase() === 'gmgn'
}

/** Percent from a fraction: GMGN's mapped token stores fractions. */
function toPercent(fraction: number): number {
  return Number.isFinite(fraction) ? fraction * 100 : 0
}

/**
 * Adapt a GMGN market-rank row into the Jupiter pool shape. `any` is deliberate:
 * this is the adapter boundary between two feeds, and the consumer pipeline is
 * typed against `JupiterPool` with `pools: any[]`.
 */
export function gmgnTokenToJupiterPool(token: GmgnFilteredTrendingToken): any {
  return {
    createdAt: token.first_seen_at,
    baseAsset: {
      id: token.token_address,
      symbol: token.token_symbol,
      name: token.token_symbol,
      icon: token.logo_url,
      usdPrice: token.price,
      mcap: token.mcap,
      organicScore: token.organic_score,
      stats1h: {
        buyVolume: token.volume_1h,
        sellVolume: 0,
        priceChange: toPercent(token.change_1h),
      },
      stats5m: {
        buyVolume: 0,
        sellVolume: 0,
        priceChange: toPercent(token.change_5m),
      },
    },
  }
}
