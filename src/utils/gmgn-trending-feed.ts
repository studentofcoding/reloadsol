import { marketTrending } from '@/utils/gmgn-api'
import type { GmgnTradeChain } from '@/utils/gmgn-currencies'
import {
  criteriaForChain,
  filterAndSortGmgnTrending,
  type GmgnFilteredCriteria,
  type GmgnFilteredTrendingToken,
} from '@/utils/gmgn-trending-filtered'
import { bulkTrackTokenMcaps, isInTrackingRange } from '@/utils/mcap-tracker'
import { cacheGet, cacheSet } from '@/utils/redis-cache'

const CACHE_TTL_SECONDS = 30

export type GmgnFilteredTrendingPayload = {
  tokens: GmgnFilteredTrendingToken[]
  total_before_filter: number
  total_after_filter: number
  filter_criteria: GmgnFilteredCriteria
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

  const criteria = criteriaForChain(chain)
  const rank = await marketTrending({
    chain,
    interval: '1h',
    limit: 100,
    // Robinhood is too young for the Solana-tuned floor — let the local filter
    // decide what we expose instead of pre-filtering at the GMGN layer.
    ...(chain === 'robinhood'
      ? {}
      : { minMarketcap: criteria.min_mcap }),
    orderBy: 'volume',
    direction: 'desc',
  })

  const filtered = filterAndSortGmgnTrending(rank, chain)
  const payload: GmgnFilteredTrendingPayload = {
    tokens: filtered.tokens,
    total_before_filter: filtered.total_before_filter,
    total_after_filter: filtered.total_after_filter,
    filter_criteria: criteria,
  }
  await cacheSet(cacheKey, payload, CACHE_TTL_SECONDS)
  ingestMcap(payload.tokens, chain)

  return { ...payload, cached: false }
}
