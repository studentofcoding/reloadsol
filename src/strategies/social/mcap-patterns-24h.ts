import { query } from '@/utils/db'
import {
  WINNER_MIN_GROWTH_PCT,
  LOSER_MAX_GROWTH_PCT,
  buildCombinedPattern,
  classifyMcapPatternCohort,
  type CombinedInternalExport,
} from './combined-pattern'
import { fetchSocialEventsForTokenSince } from './db'

const WINDOW_MS = 24 * 60 * 60 * 1000

function isMissingTableError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const e = error as { code?: string; message?: string }
    if (e.code === '42P01') return true
    if (e.message?.includes('does not exist')) return true
  }
  return false
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

type McapTrackingRow = Record<string, unknown>

export type McapPattern24hRow = {
  token_address: string
  cohort: 'winner' | 'loser'
  mcap_growth_percent: number
  first_seen_at: string
  snapshot: CombinedInternalExport
  updated_at: string
}

export type McapPatterns24hResult = {
  builtAt: string
  winners: CombinedInternalExport[]
  losers: CombinedInternalExport[]
  neutralCount: number
  tokenCount: number
  error?: string
}

function parseSnapshot(value: unknown): CombinedInternalExport {
  if (typeof value === 'string') {
    return JSON.parse(value) as CombinedInternalExport
  }
  return value as CombinedInternalExport
}

export async function listMcapSocialPatterns24h(): Promise<McapPatterns24hResult> {
  try {
    const { rows } = await query<McapPattern24hRow>(
      `SELECT token_address, cohort, mcap_growth_percent, first_seen_at, snapshot, updated_at
       FROM mcap_social_pattern_24h
       ORDER BY cohort, mcap_growth_percent DESC`,
    )

    const winners: CombinedInternalExport[] = []
    const losers: CombinedInternalExport[] = []
    let builtAt = new Date().toISOString()

    for (const row of rows) {
      const snapshot = parseSnapshot(row.snapshot)
      if (row.cohort === 'winner') winners.push(snapshot)
      else losers.push(snapshot)
      if (row.updated_at > builtAt) builtAt = row.updated_at
    }

    return {
      builtAt,
      winners,
      losers,
      neutralCount: 0,
      tokenCount: rows.length,
    }
  } catch (error) {
    if (isMissingTableError(error)) {
      return {
        builtAt: new Date().toISOString(),
        winners: [],
        losers: [],
        neutralCount: 0,
        tokenCount: 0,
        error: 'Table mcap_social_pattern_24h missing — run db/init/06-mcap-social-patterns-24h.sql',
      }
    }
    throw error
  }
}

export async function refreshMcapSocialPatterns24h(
  now = new Date(),
): Promise<McapPatterns24hResult & { upserted: number; skippedNeutral: number }> {
  const since = new Date(now.getTime() - WINDOW_MS)
  const sinceIso = since.toISOString()
  const exportedAt = now.toISOString()

  let mcapRows: McapTrackingRow[]
  try {
    const { rows } = await query<McapTrackingRow>(
      `SELECT * FROM token_mcap_tracking WHERE first_seen_at >= $1 ORDER BY first_seen_at DESC`,
      [sinceIso],
    )
    mcapRows = rows
  } catch (error) {
    if (isMissingTableError(error)) {
      return {
        builtAt: exportedAt,
        winners: [],
        losers: [],
        neutralCount: 0,
        tokenCount: 0,
        upserted: 0,
        skippedNeutral: 0,
        error: errorMessage(error),
      }
    }
    throw error
  }

  try {
    await query(`DELETE FROM mcap_social_pattern_24h WHERE first_seen_at < $1`, [sinceIso])
  } catch (error) {
    if (isMissingTableError(error)) {
      return {
        builtAt: exportedAt,
        winners: [],
        losers: [],
        neutralCount: 0,
        tokenCount: mcapRows.length,
        upserted: 0,
        skippedNeutral: 0,
        error: 'Table mcap_social_pattern_24h missing — run db/init/06-mcap-social-patterns-24h.sql',
      }
    }
    throw error
  }

  const winners: CombinedInternalExport[] = []
  const losers: CombinedInternalExport[] = []
  let neutralCount = 0
  let upserted = 0

  for (const mcapRow of mcapRows) {
    const tokenAddress = String(mcapRow.token_address ?? '')
    if (!tokenAddress) continue

    const growth = toNum(mcapRow.mcap_growth_percent)
    const cohort = classifyMcapPatternCohort(growth)
    if (cohort === 'neutral') {
      await query(`DELETE FROM mcap_social_pattern_24h WHERE token_address = $1`, [
        tokenAddress,
      ]).catch(() => {})
      neutralCount++
      continue
    }

    const socialEvents = await fetchSocialEventsForTokenSince(tokenAddress, sinceIso)
    const snapshot = buildCombinedPattern({
      tokenAddress,
      exportedAt,
      mcapRow,
      socialEvents,
    })

    const firstSeenAt = String(mcapRow.first_seen_at ?? sinceIso)

    await query(
      `INSERT INTO mcap_social_pattern_24h (
         token_address, cohort, mcap_growth_percent, first_seen_at, snapshot, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (token_address) DO UPDATE SET
         cohort = EXCLUDED.cohort,
         mcap_growth_percent = EXCLUDED.mcap_growth_percent,
         first_seen_at = EXCLUDED.first_seen_at,
         snapshot = EXCLUDED.snapshot,
         updated_at = EXCLUDED.updated_at`,
      [
        tokenAddress,
        cohort,
        growth ?? 0,
        firstSeenAt,
        JSON.stringify(snapshot),
        exportedAt,
      ],
    )

    upserted++
    if (cohort === 'winner') winners.push(snapshot)
    else losers.push(snapshot)
  }

  const growthOf = (s: CombinedInternalExport) =>
    toNum((s.mcapTracker as McapTrackingRow)?.mcap_growth_percent) ?? 0

  winners.sort((a, b) => growthOf(b) - growthOf(a))
  losers.sort((a, b) => growthOf(b) - growthOf(a))

  return {
    builtAt: exportedAt,
    winners,
    losers,
    neutralCount,
    tokenCount: mcapRows.length,
    upserted,
    skippedNeutral: neutralCount,
  }
}

export function patternRules() {
  return {
    winnerMinGrowthPct: WINNER_MIN_GROWTH_PCT,
    loserMaxGrowthPct: LOSER_MAX_GROWTH_PCT,
  }
}
