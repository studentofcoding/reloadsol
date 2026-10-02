import { query } from '@/utils/db'
import { isMissingSchemaError } from '@/utils/db-health'
import { PATTERN_TOP_SOURCE_GMGN_FOMO } from './pattern-features'
import type { SocialTokenRollupRow } from './types'
import type { SocialStrategy } from '@/strategies/types'

function isMissingRelation(error: unknown): boolean {
  return isMissingSchemaError(error)
}

export type SocialOnlyCandidate = {
  tokenAddress: string
  mentionCount30m: number
  topSource: string
  rollup: SocialTokenRollupRow
}

export type SocialOnlySkipReason =
  | 'low_mentions'
  | 'wrong_source'
  | 'missing_required_source'
  | 'on_mcap'
  | 'on_signals'
  | 'on_trending'
  | 'on_dlmm'
  | 'on_gmgn'
  | 'already_open'
  | 'already_closed'
  | 'max_candidates'

/** Pure gate for FOMO mention threshold + source (unit-testable). */
export function passesSocialOnlyRollupGate(
  rollup: Pick<SocialTokenRollupRow, 'mention_count_30m' | 'top_source'>,
  entry: SocialStrategy['config']['entry'],
): SocialOnlySkipReason | null {
  const mentions = Number(rollup.mention_count_30m) || 0
  if (mentions <= entry.minMentions30m) return 'low_mentions'
  const source = (rollup.top_source ?? '').trim()
  const want = (entry.topSource || PATTERN_TOP_SOURCE_GMGN_FOMO).trim()
  if (source !== want) return 'wrong_source'
  return null
}

export function requiredMentionSources(
  entry: SocialStrategy['config']['entry'],
): string[] {
  return (entry.requireMentionSources ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
}

export function filterSocialOnlyCandidates(params: {
  rollups: SocialTokenRollupRow[]
  entry: SocialStrategy['config']['entry']
  presentElsewhere: Set<string>
  openMints: Set<string>
  closedMints: Set<string>
  /** Mints that have required secondary sources in the last 30m (when configured). */
  requiredMentionMints?: Set<string>
}): { eligible: SocialOnlyCandidate[]; skipped: string[] } {
  const skipped: string[] = []
  const eligible: SocialOnlyCandidate[] = []
  const max = Math.max(1, params.entry.maxCandidatesPerTick)
  const requireSources = requiredMentionSources(params.entry)
  const mustHaveSecondary = requireSources.length > 0

  for (const rollup of params.rollups) {
    const mint = rollup.token_address
    if (!mint) continue

    const gate = passesSocialOnlyRollupGate(rollup, params.entry)
    if (gate) {
      skipped.push(`${mint.slice(0, 8)}: ${gate}`)
      continue
    }
    if (
      mustHaveSecondary &&
      !(params.requiredMentionMints?.has(mint) ?? false)
    ) {
      skipped.push(`${mint.slice(0, 8)}: missing_required_source`)
      continue
    }
    if (params.openMints.has(mint)) {
      skipped.push(`${mint.slice(0, 8)}: already_open`)
      continue
    }
    if (params.closedMints.has(mint)) {
      skipped.push(`${mint.slice(0, 8)}: already_closed`)
      continue
    }
    if (params.presentElsewhere.has(mint)) {
      skipped.push(`${mint.slice(0, 8)}: present_elsewhere`)
      continue
    }
    if (eligible.length >= max) {
      skipped.push(`${mint.slice(0, 8)}: max_candidates`)
      continue
    }

    eligible.push({
      tokenAddress: mint,
      mentionCount30m: Number(rollup.mention_count_30m) || 0,
      topSource: rollup.top_source ?? '',
      rollup,
    })
  }

  return { eligible, skipped }
}

/** Mints present on non-social boards that still block FOMO-first paper.
 *  Mcap tracker + trading_signals are intentionally ignored (FOMO-first). */
export async function loadMintsPresentElsewhere(
  tokenAddresses: string[],
): Promise<Set<string>> {
  const unique = Array.from(new Set(tokenAddresses.filter(Boolean)))
  if (unique.length === 0) return new Set()

  const present = new Set<string>()

  async function addFrom(sql: string): Promise<void> {
    try {
      const { rows } = await query<{ token_address: string }>(sql, [unique])
      for (const row of rows) {
        if (row.token_address) present.add(row.token_address)
      }
    } catch (error) {
      if (isMissingRelation(error)) return
      throw error
    }
  }

  await addFrom(
    `SELECT token_address FROM trending_token_tracker WHERE token_address = ANY($1::text[])`,
  )
  await addFrom(
    `SELECT token_address FROM trending_token_tracker_dev WHERE token_address = ANY($1::text[])`,
  )
  await addFrom(
    `SELECT token_address FROM dlmm_potential_list WHERE token_address = ANY($1::text[])`,
  )
  await addFrom(
    `SELECT DISTINCT token_address FROM strategy_outcomes
     WHERE domain = 'gmgn' AND token_address = ANY($1::text[])`,
  )

  return present
}

export async function loadSocialClosedMints(
  strategyId: string,
  tokenAddresses: string[],
): Promise<Set<string>> {
  const unique = Array.from(new Set(tokenAddresses.filter(Boolean)))
  if (unique.length === 0) return new Set()

  try {
    const { rows } = await query<{ token_address: string }>(
      `SELECT DISTINCT token_address FROM strategy_outcomes
       WHERE strategy_id = $1
         AND domain = 'social'
         AND token_address = ANY($2::text[])`,
      [strategyId, unique],
    )
    return new Set(rows.map((r) => r.token_address).filter(Boolean))
  } catch (error) {
    if (isMissingRelation(error)) return new Set()
    throw error
  }
}

export async function fetchFomoRollupCandidates(
  entry: SocialStrategy['config']['entry'],
  limit = 100,
): Promise<SocialTokenRollupRow[]> {
  const topSource = entry.topSource || PATTERN_TOP_SOURCE_GMGN_FOMO
  try {
    const { rows } = await query<SocialTokenRollupRow>(
      `SELECT * FROM social_token_rollups
       WHERE mention_count_30m > $1
         AND top_source = $2
       ORDER BY mention_count_30m DESC, updated_at DESC
       LIMIT $3`,
      [entry.minMentions30m, topSource, limit],
    )
    return rows
  } catch (error) {
    if (isMissingRelation(error)) return []
    throw error
  }
}

/** Burst window for FOMO detection (minutes). Env-tunable, default 30. */
export function socialBurstWindowMinutes(
  env: Record<string, string | undefined> = process.env,
): number {
  const n = Number(env.SOCIAL_BURST_WINDOW_MIN)
  return Number.isFinite(n) && n > 0 ? n : 30
}

/**
 * Burst row plus the mcap context the Jev state wants (same round trip).
 */
export type SocialBurstCandidate = SocialTokenRollupRow & {
  mcap: number | null
  first_mcap: number | null
  mcap_growth_percent: number | null
  organic_score: number | null
  top_holders_pct: number | null
}

/**
 * FOMO mention burst straight from `social_token_events` (source of truth),
 * not the 5-min-sampled rollup whose 30m window decays and whose `top_source`
 * blanks out between samples. A 2–19 min burst stays visible for the whole
 * window, so a tick never misses it. Rows are rollup-shaped so
 * `filterSocialOnlyCandidates` is reused unchanged.
 */
export async function loadFomoBurstCandidates(
  entry: SocialStrategy['config']['entry'],
  opts: { windowMinutes?: number; limit?: number; chain?: string } = {},
): Promise<SocialBurstCandidate[]> {
  const windowMinutes = opts.windowMinutes ?? socialBurstWindowMinutes()
  const limit = opts.limit ?? 100
  const chain = opts.chain ?? 'sol'
  const source = (entry.topSource || PATTERN_TOP_SOURCE_GMGN_FOMO).trim()
  const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString()
  try {
    const { rows } = await query<{
      token_address: string
      mention_count: number
      first_seen_at: string | null
      last_event_at: string | null
      unique_channel_count_30m: number | null
      mention_count_24h: number | null
      fomo_buy_count_1h: number | null
      fomo_edge_1h: number | null
      mcap: number | null
      first_mcap: number | null
      mcap_growth_percent: number | null
      organic_score: number | null
      top_holders_pct: number | null
    }>(
      `SELECT e.token_address,
              COUNT(*)::int AS mention_count,
              MIN(e.occurred_at) AS first_seen_at,
              MAX(e.occurred_at) AS last_event_at,
              r.unique_channel_count_30m,
              r.mention_count_24h,
              r.fomo_buy_count_1h,
              r.fomo_edge_1h,
              m.current_mcap AS mcap,
              m.first_mcap,
              m.mcap_growth_percent,
              m.organic_score,
              m.top_holders_pct
         FROM social_token_events e
         LEFT JOIN social_token_rollups r ON r.token_address = e.token_address
         LEFT JOIN token_mcap_tracking m
                ON m.token_address = e.token_address AND m.chain = e.chain
        WHERE e.event_type = 'mention'
          AND e.source = $1
          AND e.chain = $2
          AND e.occurred_at >= $3
        GROUP BY e.token_address, r.unique_channel_count_30m, r.mention_count_24h,
                 r.fomo_buy_count_1h, r.fomo_edge_1h,
                 m.current_mcap, m.first_mcap, m.mcap_growth_percent,
                 m.organic_score, m.top_holders_pct
       HAVING COUNT(*) > $4
        ORDER BY mention_count DESC
        LIMIT $5`,
      [source, chain, cutoff, entry.minMentions30m, limit],
    )
    const now = new Date().toISOString()
    return rows.map((row) => ({
      token_address: row.token_address,
      first_seen_at: row.first_seen_at,
      first_source: source,
      first_channel: null,
      mention_count_5m: 0,
      mention_count_30m: row.mention_count,
      mention_count_24h: row.mention_count_24h ?? row.mention_count,
      unique_channel_count_30m: row.unique_channel_count_30m ?? 0,
      smart_wallet_buy_count_1h: 0,
      smart_wallet_buy_sol_1h: 0,
      top_source: source,
      last_event_at: row.last_event_at,
      updated_at: now,
      fomo_buy_count_1h: row.fomo_buy_count_1h ?? 0,
      fomo_edge_1h: row.fomo_edge_1h,
      mcap: row.mcap,
      first_mcap: row.first_mcap,
      mcap_growth_percent: row.mcap_growth_percent,
      organic_score: row.organic_score,
      top_holders_pct: row.top_holders_pct,
    }))
  } catch (error) {
    if (isMissingRelation(error)) return []
    throw error
  }
}

/** Mints with a mention from any of `sources` in the last 30 minutes. */
export async function loadMintsWithRequiredMentionSources(
  sources: string[],
  tokenAddresses: string[],
): Promise<Set<string>> {
  const uniqueSources = Array.from(new Set(sources.map((s) => s.trim()).filter(Boolean)))
  const uniqueMints = Array.from(new Set(tokenAddresses.filter(Boolean)))
  if (uniqueSources.length === 0 || uniqueMints.length === 0) return new Set()

  try {
    const { rows } = await query<{ token_address: string }>(
      `SELECT DISTINCT token_address FROM social_token_events
       WHERE event_type = 'mention'
         AND source = ANY($1::text[])
         AND occurred_at >= NOW() - INTERVAL '30 minutes'
         AND token_address = ANY($2::text[])`,
      [uniqueSources, uniqueMints],
    )
    return new Set(rows.map((r) => r.token_address).filter(Boolean))
  } catch (error) {
    if (isMissingRelation(error)) return new Set()
    throw error
  }
}
