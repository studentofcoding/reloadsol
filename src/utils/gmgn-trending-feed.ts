import { marketTrending } from '@/utils/gmgn-api'
import type { GmgnTradeChain } from '@/utils/gmgn-currencies'
import {
  filterAndSortGmgnTrending,
  GMGN_FILTERED_CRITERIA,
  type GmgnFilteredTrendingToken,
} from '@/utils/gmgn-trending-filtered'
import { bulkTrackTokenMcaps, isInTrackingRange } from '@/utils/mcap-tracker'
import { cacheGet, cacheSet } from '@/utils/redis-cache'

const CACHE_TTL_SECONDS = 30

export type GmgnFilteredTrendingPayload = {
  tokens: GmgnFilteredTrendingToken[]
  total_before_filter: number
  total_after_filter: number
}

/** Feed the mcap tracker so the signals / mcap_tracker domains get candidates. */
function ingestMcap(tokens: GmgnFilteredTrendingToken[], chain: GmgnTradeChain) {
  const inRange = tokens
    .filter((t) => isInTrackingRange(t.mcap))
    .map((t) => ({ address: t.token_address, symbol: t.token_symbol, mcap: t.mcap }))
  if (inRange.length === 0) return
  void bulkTrackTokenMcaps(inRange, chain).catch((error) => {
    console.warn('[gmgn-trending-feed] mcap ingest failed:', error)
  })
}

/**
 * Filtered GMGN market-rank feed, shared by the UI route and the trending_bot
 * sim cycle so both read the same 30s-cached list and only one of them pays.
 */
export async function getFilteredGmgnTrending(
  chain: GmgnTradeChain,
): Promise<GmgnFilteredTrendingPayload & { cached: boolean }> {
  const cacheKey = `gmgn:trending:filtered:${chain}`
  const cached = await cacheGet<GmgnFilteredTrendingPayload>(cacheKey)
  if (cached) return { ...cached, cached: true }

  const rank = await marketTrending({
    chain,
    interval: '1h',
    limit: 100,
    minMarketcap: GMGN_FILTERED_CRITERIA.min_mcap,
    orderBy: 'volume',
    direction: 'desc',
  })

  const payload = filterAndSortGmgnTrending(rank)
  await cacheSet(cacheKey, payload, CACHE_TTL_SECONDS)
  ingestMcap(payload.tokens, chain)

  return { ...payload, cached: false }
}
