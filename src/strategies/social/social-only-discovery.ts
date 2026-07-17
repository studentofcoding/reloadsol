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

/** Mints present on non-social boards (or open gmgn outcomes). */
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
    `SELECT token_address FROM token_mcap_tracking WHERE token_address = ANY($1::text[])`,
  )
  await addFrom(
    `SELECT token_address FROM trading_signals WHERE token_address = ANY($1::text[])`,
  )
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
