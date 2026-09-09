import { marketTrending } from '@/utils/gmgn-api'
import type { GmgnTradeChain } from '@/utils/gmgn-currencies'
import {
  criteriaForChain,
  filterAndSortGmgnTrending,
  type GmgnFilteredCriteria,
  type GmgnFilteredTrendingToken,
} from '@/utils/gmgn-trending-filtered'
import { bulkTrackTokenMcaps, isInTrackingRange } from '@/utils/mcap-tracker'
import { attachFirstDetections } from '@/utils/first-detection'
import { fetchWithCache } from '@/utils/portfolio-cache'

// The server owns the upstream call: one GMGN fetch per chain per window
// (5 min), and every client just reads this cached snapshot. Long stale TTL
// means a GMGN 429/outage serves the last-good list instead of erroring.
const CACHE_TTL_SECONDS = 300
const STALE_TTL_SECONDS = 3600

// Collapse concurrent expiries (several clients polling at once must not each
// trigger an upstream GMGN call).
const inflight = new Map<string, Promise<unknown>>()

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
  let run = inflight.get(cacheKey) as
    | Promise<{ data: GmgnFilteredTrendingPayload; origin: 'hit' | 'miss' | 'stale' }>
    | undefined
  if (!run) {
    run = fetchWithCache<GmgnFilteredTrendingPayload>({
      key: cacheKey,
      staleKey: `${cacheKey}:stale`,
      ttlSeconds: CACHE_TTL_SECONDS,
      staleTtlSeconds: STALE_TTL_SECONDS,
      fetch: async () => {
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
        ingestMcap(payload.tokens, chain)
        return payload
      },
    }).finally(() => inflight.delete(cacheKey))
    inflight.set(cacheKey, run)
  }

  const { data, origin } = await run
  return {
    ...data,
    tokens: await attachFirstDetections(data.tokens, chain),
    cached: origin !== 'miss',
  }
}
