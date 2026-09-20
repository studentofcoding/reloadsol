import { getFilteredGmgnTrending } from '@/utils/gmgn-trending-feed'
import type { GmgnTradeChain } from '@/utils/gmgn-currencies'
import {
  buildTrackerSocialJoinMap,
  type TrackerSocialEnrichment,
  type TrendingSocialFields,
} from '@/utils/tracker-social-join'

/** Batch join keyed by mint. Uses the 2–5 min GMGN trending cache. Fail-soft. */
export async function loadTrackerSocialJoinMap(opts: {
  chain: GmgnTradeChain
  jupiterTokens?: TrendingSocialFields[]
}): Promise<Map<string, TrackerSocialEnrichment>> {
  let gmgnRows: TrendingSocialFields[] = []
  try {
    const feed = await getFilteredGmgnTrending(opts.chain)
    gmgnRows = feed.tokens
  } catch (error) {
    console.warn('[tracker-social-join] GMGN filtered trending unavailable', error)
  }
  return buildTrackerSocialJoinMap(gmgnRows, opts.jupiterTokens ?? [])
}
