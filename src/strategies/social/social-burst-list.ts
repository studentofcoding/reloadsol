import { SOCIAL_STRATEGIES } from '@/strategies/registry'
import type { SignalsListPoolItem } from '@/strategies/signals-strategy-list'
import { loadFomoBurstCandidates, socialBurstWindowMinutes } from './social-only-discovery'

const SOCIAL_LIST_STRATEGY_ID = 'social_only_fomo_gt7'

/**
 * Rows for the Signals-tab social entry: the live FOMO burst set — the same
 * events-derived candidates `social_only_fomo_gt7` acts on, including mints that
 * did not open. Shaped as a signals row so the list, sorting and row actions are
 * reused; `score` carries the 30m mention count.
 */
export async function loadSocialBurstListPool(
  chain: 'sol' | 'robinhood',
  opts: { limit?: number } = {},
): Promise<SignalsListPoolItem[]> {
  const strategy = SOCIAL_STRATEGIES[SOCIAL_LIST_STRATEGY_ID]
  if (!strategy || chain !== 'sol') return []

  const limit = opts.limit ?? 100
  const windowMinutes = socialBurstWindowMinutes()
  const nowIso = new Date().toISOString()
  const bursts = await loadFomoBurstCandidates(strategy.config.entry, { chain, limit })

  return bursts.map((burst) => {
    const mentions = burst.mention_count_30m
    return {
      token_address: burst.token_address,
      token_symbol: burst.token_address.slice(0, 8),
      first_mcap: burst.first_mcap ?? 0,
      current_mcap: burst.mcap ?? 0,
      mcap_growth_percent: burst.mcap_growth_percent ?? 0,
      first_seen_at: burst.first_seen_at ?? nowIso,
      last_updated_at: burst.last_event_at ?? nowIso,
      peak_mcap: null,
      peak_growth_percent: null,
      peak_seen_at: null,
      label: null,
      is_tracking_stuck: false,
      in_tracking_range: true,
      trend_age_minutes: 0,
      score: mentions,
      decision: 'enter' as const,
      rationale: `FOMO ${mentions} mentions / ${windowMinutes}m`,
      organic_score: burst.organic_score,
      top_holders_pct: burst.top_holders_pct,
      social_entry: true,
      mention_count_30m: mentions,
      top_source: burst.top_source,
    }
  })
}
