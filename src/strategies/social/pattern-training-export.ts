import { query } from '@/utils/db'
import type { AppNetwork } from '@/utils/app-network'
import { parseDbChain } from '@/utils/app-network-db'
import {
  extractPatternFeaturesFromSnapshot,
  patternClassFromCohort,
  type PatternFeatureKey,
  PATTERN_FEATURE_KEYS,
} from './pattern-features'
import type { CombinedInternalExport } from './combined-pattern'

export type PatternTrainingRow = {
  token_address: string
  chain: 'sol' | 'robinhood'
  cohort: 'winner' | 'loser'
  pattern_class: 0 | 1
  first_seen_at: string
  exported_at: string
} & Record<PatternFeatureKey, number>

function parseSnapshot(value: unknown): CombinedInternalExport | null {
  if (value == null) return null
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as CombinedInternalExport
    } catch {
      return null
    }
  }
  return value as CombinedInternalExport
}

function toIso(value: unknown, fallback: string): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' && value) return value
  return fallback
}

export async function listPatternTrainingRows(
  chain: AppNetwork = 'sol',
): Promise<{
  rows: PatternTrainingRow[]
  skipped: number
  error?: string
}> {
  const scoped = parseDbChain(chain)
  try {
    const { rows: dbRows } = await query<{
      token_address: string
      chain: string
      cohort: string
      first_seen_at: unknown
      snapshot: unknown
      updated_at: unknown
    }>(
      `SELECT token_address, chain, cohort, first_seen_at, snapshot, updated_at
       FROM mcap_social_pattern_24h
       WHERE cohort IN ('winner', 'loser') AND chain = $1
       ORDER BY first_seen_at ASC`,
      [scoped],
    )

    const rows: PatternTrainingRow[] = []
    let skipped = 0

    for (const row of dbRows) {
      const patternClass = patternClassFromCohort(row.cohort)
      if (patternClass == null) {
        skipped++
        continue
      }

      const snapshot = parseSnapshot(row.snapshot)
      if (!snapshot) {
        skipped++
        continue
      }

      const features = extractPatternFeaturesFromSnapshot(snapshot)
      if (!features) {
        skipped++
        continue
      }

      rows.push({
        token_address: row.token_address,
        chain: (row.chain === 'robinhood' ? 'robinhood' : 'sol') as 'sol' | 'robinhood',
        cohort: row.cohort as 'winner' | 'loser',
        pattern_class: patternClass,
        first_seen_at: toIso(row.first_seen_at, new Date().toISOString()),
        exported_at: new Date().toISOString(),
        ...(features as Record<PatternFeatureKey, number>),
      })
    }

    return { rows, skipped }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('does not exist') || message.includes('42P01')) {
      return {
        rows: [],
        skipped: 0,
        error: 'Table mcap_social_pattern_24h missing — run db/init/06-mcap-social-patterns-24h.sql',
      }
    }
    throw error
  }
}

export async function getPatternTrainingStats(
  chain: AppNetwork = 'sol',
): Promise<{
  winnerCount: number
  loserCount: number
  exportableRows: number
  skippedIncomplete: number
  trainReady: boolean
  error?: string
}> {
  const { rows, skipped, error } = await listPatternTrainingRows(chain)
  const winnerCount = rows.filter((r) => r.cohort === 'winner').length
  const loserCount = rows.filter((r) => r.cohort === 'loser').length
  const trainReady = winnerCount >= 30 && loserCount >= 30

  return {
    winnerCount,
    loserCount,
    exportableRows: rows.length,
    skippedIncomplete: skipped,
    trainReady,
    error,
  }
}

export type PatternFeatureCoverage = Record<
  PatternFeatureKey,
  { nonNull: number; nonZero: number; nonNullRate: number; nonZeroRate: number }
>

/**
 * Per-feature non-null / non-zero rates at export time. Social features with
 * 0 model importance can be missing upstream (all-zero here) or merely
 * uninformative (covered but no signal) — this distinguishes the two.
 */
export function patternTrainingFeatureCoverage(
  rows: PatternTrainingRow[],
): PatternFeatureCoverage {
  const n = rows.length
  const coverage = {} as PatternFeatureCoverage
  for (const key of PATTERN_FEATURE_KEYS) {
    let nonNull = 0
    let nonZero = 0
    for (const row of rows) {
      const value = row[key]
      if (value != null && !Number.isNaN(value)) {
        nonNull++
        if (value !== 0) nonZero++
      }
    }
    coverage[key] = {
      nonNull,
      nonZero,
      nonNullRate: n > 0 ? nonNull / n : 0,
      nonZeroRate: n > 0 ? nonZero / n : 0,
    }
  }
  return coverage
}

export function patternTrainingCsvHeader(): string {
  return [
    'token_address',
    'chain',
    'cohort',
    'pattern_class',
    'first_seen_at',
    'exported_at',
    ...PATTERN_FEATURE_KEYS,
  ].join(',')
}

export function patternTrainingRowToCsv(row: PatternTrainingRow): string {
  const cells = [
    row.token_address,
    row.chain,
    row.cohort,
    String(row.pattern_class),
    row.first_seen_at,
    row.exported_at,
    ...PATTERN_FEATURE_KEYS.map((k) => String(row[k])),
  ]
  return cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')
}

export async function fetchPatternCohortByToken(
  chain: AppNetwork = 'sol',
): Promise<Map<string, 'winner' | 'loser'>> {
  const scoped = parseDbChain(chain)
  try {
    const { rows } = await query<{ token_address: string; cohort: string }>(
      `SELECT token_address, cohort FROM mcap_social_pattern_24h
       WHERE cohort IN ('winner', 'loser') AND chain = $1`,
      [scoped],
    )
    const map = new Map<string, 'winner' | 'loser'>()
    for (const row of rows) {
      if (row.cohort === 'winner' || row.cohort === 'loser') {
        map.set(row.token_address, row.cohort)
      }
    }
    return map
  } catch {
    return new Map()
  }
}
