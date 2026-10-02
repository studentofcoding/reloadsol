/**
 * Precomputed `consensus` + `capital` sections for `GET /api/strategies/reports`.
 *
 * Both are whole-analysis outputs — a seeded bootstrap over the report window and a 3-day
 * paper-capital sweep — that do not depend on the report's row-level filters, and together
 * they were the majority of its cold-cache DB round trips (see
 * ~/.commandcode/plans/reports-structural-latency.md). They are refreshed by the
 * `report_precompute` worker and read back per (chain, domain, sim, tz).
 *
 * The report serves the last stored row even when it is old: this is a measurement, not a
 * live value, and the response carries `precompute.computed_at` so the age is visible.
 */

import { query } from '@/utils/db'
import { isMissingSchemaError } from '@/utils/db-health'
import { loadConsensusTest, loadPaperCapital } from './db'
import type { ConsensusTestResult } from './consensus-test'
import {
  DEFAULT_REPORT_TIMEZONE,
  REPORT_TIMEZONES,
} from './best-trade-windows'
import { STRATEGY_CHAINS, type StrategyChain, type StrategyDomain } from './types'
import type { PaperCapitalSummary } from './types'

export const REPORT_PRECOMPUTE_TABLE = 'strategy_report_precompute'

export type ReportPrecomputePayload = {
  consensus: ConsensusTestResult | null
  capital: PaperCapitalSummary[]
  computed_at: string
}

export type ReportPrecomputeTarget = {
  chain: StrategyChain
  domain?: StrategyDomain
  isSimulated?: boolean
  timeZone: string
}

/** Deliberately mirrors the report's cache key so a stored row maps to one filter shape. */
export function reportPrecomputeKey(target: {
  chain: string
  domain?: StrategyDomain | null
  isSimulated?: boolean | null
  timeZone?: string | null
}): string {
  return [
    'report-precompute:v1',
    target.chain,
    target.domain ?? 'all',
    String(target.isSimulated ?? 'all'),
    target.timeZone ?? DEFAULT_REPORT_TIMEZONE,
  ].join(':')
}

/** The bounded set the worker refreshes: 2 chains x (6 domains + all) x 2 timezones. */
export function reportPrecomputeTargets(): ReportPrecomputeTarget[] {
  const domains: Array<StrategyDomain | undefined> = [
    undefined,
    'trending_bot',
    'signals',
    'dlmm',
    'mcap_tracker',
    'gmgn',
    'social',
  ]
  const targets: ReportPrecomputeTarget[] = []
  for (const chain of STRATEGY_CHAINS) {
    for (const domain of domains) {
      for (const timeZone of REPORT_TIMEZONES) {
        targets.push({ chain, domain, timeZone })
      }
    }
  }
  return targets
}

export async function loadReportPrecompute(
  key: string,
): Promise<ReportPrecomputePayload | null> {
  try {
    const { rows } = await query<{
      payload: ReportPrecomputePayload | string
      computed_at: string
    }>(
      `SELECT payload, computed_at FROM ${REPORT_PRECOMPUTE_TABLE} WHERE key = $1`,
      [key],
    )
    const row = rows[0]
    if (!row) return null
    const payload =
      typeof row.payload === 'string'
        ? (JSON.parse(row.payload) as ReportPrecomputePayload)
        : row.payload
    return { ...payload, computed_at: row.computed_at }
  } catch (error) {
    // A missing table just means the worker has never run: fall back to computing live.
    if (!isMissingSchemaError(error)) {
      console.warn('[strategies/report-precompute] load failed:', error)
    }
    return null
  }
}

/** Compute one target's two sections. Same functions the report uses, same filters. */
export async function computeReportPrecompute(
  target: ReportPrecomputeTarget,
): Promise<Omit<ReportPrecomputePayload, 'computed_at'>> {
  const [consensus, capital] = await Promise.all([
    loadConsensusTest({
      chain: target.chain,
      domain: target.domain,
      isSimulated: target.isSimulated,
    }),
    loadPaperCapital({ chain: target.chain, days: 3, timeZone: target.timeZone }),
  ])
  return { consensus, capital: [capital] }
}

export async function storeReportPrecompute(
  key: string,
  payload: Omit<ReportPrecomputePayload, 'computed_at'>,
): Promise<void> {
  await query(
    `INSERT INTO ${REPORT_PRECOMPUTE_TABLE} (key, payload, computed_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE
       SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at`,
    [key, JSON.stringify(payload)],
  )
}

export type ReportPrecomputeRun = {
  keys: number
  upserted: number
  failed: number
  duration_ms: number
  errors: string[]
}

/**
 * Refresh every target. Per-target failures are collected, never fatal: a stale row is
 * better than no row, so one bad filter shape must not stop the rest of the sweep.
 */
export async function refreshReportPrecompute(): Promise<ReportPrecomputeRun> {
  const startedAt = Date.now()
  const targets = reportPrecomputeTargets()
  let upserted = 0
  const errors: string[] = []

  for (const target of targets) {
    const key = reportPrecomputeKey(target)
    try {
      const payload = await computeReportPrecompute(target)
      await storeReportPrecompute(key, payload)
      upserted++
    } catch (error) {
      errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    keys: targets.length,
    upserted,
    failed: errors.length,
    duration_ms: Date.now() - startedAt,
    errors: errors.slice(0, 5),
  }
}
