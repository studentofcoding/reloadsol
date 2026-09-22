/**
 * DB access for early_enter_noul_shadow (SPEC-jev-soft-gate-shadow-v1).
 * Fail-soft on missing schema — never throw past Early Enter emit.
 */

import { query } from '@/utils/db'
import { isMissingSchemaError } from '@/utils/db-health'
import type { AppNetwork } from '@/utils/app-network'
import type {
  EarlyEnterNoulStrategyKey,
  NoulFilterReason,
  NoulShadowBand,
  NoulShadowDecision,
  NoulSpecDecision,
} from './early-enter-noul-shadow'
import {
  evaluateFlipBars,
  evaluateKillSwitchWindow,
  filterReasonFromBand,
  flipArmFamilyFromStrategyKey,
  getApiMissKillRate,
  getDisagreementKillRate,
  isNoulShadowBand,
  mergeKillSwitches,
  strategyKeysForArmFamily,
  FLIP_AGREEMENT_MIN,
  FLIP_MID_MAX,
  FLIP_N_MIN,
  KILL_SWITCH_MIN_N,
  type FlipArmFamily,
  type FlipBarCheck,
  type KillSwitchCheck,
} from './early-enter-noul-shadow'

let ensurePromise: Promise<void> | null = null

async function ensureEarlyEnterNoulShadowTable(): Promise<void> {
  if (ensurePromise) {
    await ensurePromise
    return
  }
  ensurePromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS early_enter_noul_shadow (
        id BIGSERIAL PRIMARY KEY,
        predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        token_address TEXT NOT NULL,
        symbol TEXT,
        chain TEXT NOT NULL DEFAULT 'sol',
        strategy_key TEXT NOT NULL,
        cl_ml_score DOUBLE PRECISION,
        cl_model_version TEXT,
        spec_would_pass BOOLEAN NOT NULL,
        noul_called BOOLEAN NOT NULL DEFAULT FALSE,
        noul DOUBLE PRECISION,
        band TEXT NOT NULL
          CHECK (band IN ('suppress', 'mid', 'keep', 'skipped_null', 'api_miss')),
        decision_shadow TEXT NOT NULL
          CHECK (decision_shadow IN ('keep', 'suppress', 'follow_spec')),
        decision_spec TEXT NOT NULL
          CHECK (decision_spec IN ('keep', 'suppress'))
      )
    `)
    await query(`
      CREATE INDEX IF NOT EXISTS early_enter_noul_shadow_predicted_at_idx
      ON early_enter_noul_shadow (predicted_at DESC)
    `)
    await query(`
      CREATE INDEX IF NOT EXISTS early_enter_noul_shadow_strategy_predicted_idx
      ON early_enter_noul_shadow (strategy_key, predicted_at DESC)
    `)
  })()
    .then(() => undefined)
    .catch((err) => {
      ensurePromise = null
      throw err
    })
  await ensurePromise
}

export type EarlyEnterNoulShadowRow = {
  tokenAddress: string
  symbol?: string | null
  chain: AppNetwork
  strategyKey: EarlyEnterNoulStrategyKey | string
  clMlScore: number | null
  clModelVersion: string | null
  specWouldPass: boolean
  noulCalled: boolean
  noul: number | null
  band: NoulShadowBand
  decisionShadow: NoulShadowDecision
  decisionSpec: NoulSpecDecision
}

export async function insertEarlyEnterNoulShadowRow(
  row: EarlyEnterNoulShadowRow,
): Promise<void> {
  try {
    await ensureEarlyEnterNoulShadowTable()
    await query(
      `INSERT INTO early_enter_noul_shadow (
         token_address, symbol, chain, strategy_key,
         cl_ml_score, cl_model_version, spec_would_pass,
         noul_called, noul, band, decision_shadow, decision_spec
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        row.tokenAddress,
        row.symbol ?? null,
        row.chain,
        row.strategyKey,
        row.clMlScore,
        row.clModelVersion,
        row.specWouldPass,
        row.noulCalled,
        row.noul,
        row.band,
        row.decisionShadow,
        row.decisionSpec,
      ],
    )
  } catch (error) {
    if (isMissingSchemaError(error)) return
    // Fail-soft: log sink must not break Early Enter emit
    console.error('[early-enter-noul-shadow] insert failed:', error)
  }
}

export type EarlyEnterNoulCompareStats = {
  strategyKey: string
  total: number
  midBand: number
  midBandRate: number | null
  /** band = api_miss (soft-fail). Counted separately from mid-band. */
  apiMiss: number
  apiMissRate: number | null
  /** Rows with decision_shadow in {keep,suppress} (excludes follow_spec / skipped_null / api_miss soft-fail). */
  agreementEligible: number
  agreementMatches: number
  agreementRate: number | null
}

/**
 * Agreement excludes follow_spec and skipped_null from numerator/denominator (SPEC fog default).
 * Mid-band rate = share with band = mid over all rows in window.
 */
export async function loadEarlyEnterNoulCompareStats(
  hours = 24,
): Promise<EarlyEnterNoulCompareStats[]> {
  try {
    await ensureEarlyEnterNoulShadowTable()
    const { rows } = await query<{
      strategy_key: string
      total: string | number
      mid_band: string | number
      api_miss: string | number
      agreement_eligible: string | number
      agreement_matches: string | number
    }>(
      `SELECT
         strategy_key,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE band = 'mid')::int AS mid_band,
         COUNT(*) FILTER (WHERE band = 'api_miss')::int AS api_miss,
         COUNT(*) FILTER (
           WHERE decision_shadow IN ('keep', 'suppress')
         )::int AS agreement_eligible,
         COUNT(*) FILTER (
           WHERE decision_shadow IN ('keep', 'suppress')
             AND decision_shadow = decision_spec
         )::int AS agreement_matches
       FROM early_enter_noul_shadow
       WHERE predicted_at >= NOW() - ($1 * INTERVAL '1 hour')
       GROUP BY strategy_key
       ORDER BY strategy_key`,
      [hours],
    )

    return rows.map((r) => {
      const total = Number(r.total) || 0
      const midBand = Number(r.mid_band) || 0
      const apiMiss = Number(r.api_miss) || 0
      const agreementEligible = Number(r.agreement_eligible) || 0
      const agreementMatches = Number(r.agreement_matches) || 0
      return {
        strategyKey: r.strategy_key,
        total,
        midBand,
        midBandRate: total > 0 ? midBand / total : null,
        apiMiss,
        apiMissRate: total > 0 ? apiMiss / total : null,
        agreementEligible,
        agreementMatches,
        agreementRate:
          agreementEligible > 0 ? agreementMatches / agreementEligible : null,
      }
    })
  } catch (error) {
    if (isMissingSchemaError(error)) return []
    console.error('[early-enter-noul-shadow] stats failed:', error)
    return []
  }
}

export type EarlyEnterNoulShadowListRow = {
  id: number
  predictedAt: string
  tokenAddress: string
  symbol: string | null
  chain: string
  strategyKey: string
  clMlScore: number | null
  specWouldPass: boolean
  noulCalled: boolean
  noul: number | null
  band: NoulShadowBand
  /** Derived from band: skipped_null → null_ml. */
  filterReason: NoulFilterReason
  decisionShadow: NoulShadowDecision
  decisionSpec: NoulSpecDecision
}

export type LoadEarlyEnterNoulShadowRowsOpts = {
  hours?: number
  limit?: number
  offset?: number
  strategyKey?: string | null
  /** first_seen | at_80 — filters to that arm family when strategyKey unset. */
  arm?: FlipArmFamily | null
  band?: NoulShadowBand | null
}

export type LoadEarlyEnterNoulShadowRowsResult = {
  rows: EarlyEnterNoulShadowListRow[]
  total: number
  limit: number
  offset: number
}

/**
 * Recent shadow rows for Admin funnel view — filter by hours / strategy_key / arm / band.
 * Default last 100 in the hours window (newest first).
 */
export async function loadEarlyEnterNoulShadowRows(
  opts: LoadEarlyEnterNoulShadowRowsOpts = {},
): Promise<LoadEarlyEnterNoulShadowRowsResult> {
  const hours =
    opts.hours != null && Number.isFinite(opts.hours) && opts.hours > 0
      ? Math.min(Math.floor(opts.hours), 168)
      : 24
  const limitRaw = opts.limit ?? 100
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), 500)
      : 100
  const offsetRaw = opts.offset ?? 0
  const offset =
    Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0
  const strategyKey =
    opts.strategyKey && opts.strategyKey.trim() ? opts.strategyKey.trim() : null
  const arm = opts.arm === 'first_seen' || opts.arm === 'at_80' ? opts.arm : null
  const band =
    opts.band && isNoulShadowBand(opts.band) ? opts.band : null

  try {
    await ensureEarlyEnterNoulShadowTable()

    const where: string[] = [
      `predicted_at >= NOW() - ($1 * INTERVAL '1 hour')`,
    ]
    const params: Array<string | number> = [hours]
    let p = 2

    if (strategyKey) {
      where.push(`strategy_key = $${p}`)
      params.push(strategyKey)
      p += 1
    } else if (arm) {
      const keys = strategyKeysForArmFamily(arm)
      const placeholders = keys.map((_, i) => `$${p + i}`).join(', ')
      where.push(`strategy_key IN (${placeholders})`)
      params.push(...keys)
      p += keys.length
    }
    if (band) {
      where.push(`band = $${p}`)
      params.push(band)
      p += 1
    }

    const whereSql = where.join(' AND ')

    const { rows: countRows } = await query<{ total: string | number }>(
      `SELECT COUNT(*)::int AS total
       FROM early_enter_noul_shadow
       WHERE ${whereSql}`,
      params,
    )
    const total = Number(countRows[0]?.total) || 0

    const listParams = [...params, limit, offset]
    const limitIdx = p
    const offsetIdx = p + 1

    const { rows } = await query<{
      id: string | number
      predicted_at: Date | string
      token_address: string
      symbol: string | null
      chain: string
      strategy_key: string
      cl_ml_score: string | number | null
      spec_would_pass: boolean
      noul_called: boolean
      noul: string | number | null
      band: NoulShadowBand
      decision_shadow: NoulShadowDecision
      decision_spec: NoulSpecDecision
    }>(
      `SELECT
         id,
         predicted_at,
         token_address,
         symbol,
         chain,
         strategy_key,
         cl_ml_score,
         spec_would_pass,
         noul_called,
         noul,
         band,
         decision_shadow,
         decision_spec
       FROM early_enter_noul_shadow
       WHERE ${whereSql}
       ORDER BY predicted_at DESC, id DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      listParams,
    )

    return {
      rows: rows.map((r) => {
        const bandVal = r.band
        return {
          id: Number(r.id),
          predictedAt:
            r.predicted_at instanceof Date
              ? r.predicted_at.toISOString()
              : String(r.predicted_at),
          tokenAddress: r.token_address,
          symbol: r.symbol ?? null,
          chain: r.chain,
          strategyKey: r.strategy_key,
          clMlScore:
            r.cl_ml_score == null || r.cl_ml_score === ''
              ? null
              : Number(r.cl_ml_score),
          specWouldPass: Boolean(r.spec_would_pass),
          noulCalled: Boolean(r.noul_called),
          noul: r.noul == null || r.noul === '' ? null : Number(r.noul),
          band: bandVal,
          filterReason: filterReasonFromBand(bandVal),
          decisionShadow: r.decision_shadow,
          decisionSpec: r.decision_spec,
        }
      }),
      total,
      limit,
      offset,
    }
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return { rows: [], total: 0, limit, offset }
    }
    console.error('[early-enter-noul-shadow] list failed:', error)
    return { rows: [], total: 0, limit, offset }
  }
}

export type NoulFlipWindowCounts = {
  total: number
  midBand: number
  apiMiss: number
  agreementEligible: number
  agreementMatches: number
  total24h: number
  apiMiss24h: number
  agreementEligible24h: number
  agreementMatches24h: number
}

export type EarlyEnterNoulFlipStrategyStats = EarlyEnterNoulCompareStats &
  NoulFlipWindowCounts & {
    apiMissRate24h: number | null
    arm: FlipArmFamily | null
    bars: FlipBarCheck
    kill: KillSwitchCheck
  }

export type EarlyEnterNoulFlipArmStats = NoulFlipWindowCounts & {
  arm: FlipArmFamily | 'all'
  midBandRate: number | null
  apiMissRate: number | null
  apiMissRate24h: number | null
  agreementRate: number | null
  bars: FlipBarCheck
  kill: KillSwitchCheck
}

export type EarlyEnterNoulFlipReadiness = {
  bars: {
    nMin: number
    agreementMin: number
    midMax: number
  }
  /** #54 kill thresholds. A spike holds soft-active off; it does not enable it. */
  kill: {
    apiMissMax: number
    disagreementMax: number
    minN: number
  }
  /** All-time rows across every strategy_key. */
  overall: EarlyEnterNoulFlipArmStats
  byArm: EarlyEnterNoulFlipArmStats[]
  byStrategy: EarlyEnterNoulFlipStrategyStats[]
}

function ratesFromCounts(opts: {
  total: number
  midBand: number
  agreementEligible: number
  agreementMatches: number
}): Pick<
  EarlyEnterNoulCompareStats,
  'midBandRate' | 'agreementRate'
> {
  const { total, midBand, agreementEligible, agreementMatches } = opts
  return {
    midBandRate: total > 0 ? midBand / total : null,
    agreementRate:
      agreementEligible > 0 ? agreementMatches / agreementEligible : null,
  }
}

function emptyFlipCounts(): NoulFlipWindowCounts {
  return {
    total: 0,
    midBand: 0,
    apiMiss: 0,
    agreementEligible: 0,
    agreementMatches: 0,
    total24h: 0,
    apiMiss24h: 0,
    agreementEligible24h: 0,
    agreementMatches24h: 0,
  }
}

function addFlipCounts(
  a: NoulFlipWindowCounts,
  b: NoulFlipWindowCounts,
): NoulFlipWindowCounts {
  return {
    total: a.total + b.total,
    midBand: a.midBand + b.midBand,
    apiMiss: a.apiMiss + b.apiMiss,
    agreementEligible: a.agreementEligible + b.agreementEligible,
    agreementMatches: a.agreementMatches + b.agreementMatches,
    total24h: a.total24h + b.total24h,
    apiMiss24h: a.apiMiss24h + b.apiMiss24h,
    agreementEligible24h: a.agreementEligible24h + b.agreementEligible24h,
    agreementMatches24h: a.agreementMatches24h + b.agreementMatches24h,
  }
}

function killForCounts(slice: NoulFlipWindowCounts): KillSwitchCheck {
  const apiMissMax = getApiMissKillRate()
  const disagreementMax = getDisagreementKillRate()
  return mergeKillSwitches(
    evaluateKillSwitchWindow({
      total: slice.total,
      apiMiss: slice.apiMiss,
      agreementEligible: slice.agreementEligible,
      agreementMatches: slice.agreementMatches,
      apiMissMax,
      disagreementMax,
    }),
    evaluateKillSwitchWindow({
      total: slice.total24h,
      apiMiss: slice.apiMiss24h,
      agreementEligible: slice.agreementEligible24h,
      agreementMatches: slice.agreementMatches24h,
      apiMissMax,
      disagreementMax,
    }),
  )
}

function flipMetrics(slice: NoulFlipWindowCounts): {
  midBandRate: number | null
  apiMissRate: number | null
  apiMissRate24h: number | null
  agreementRate: number | null
  bars: FlipBarCheck
  kill: KillSwitchCheck
} {
  const rates = ratesFromCounts(slice)
  return {
    midBandRate: rates.midBandRate,
    apiMissRate: slice.total > 0 ? slice.apiMiss / slice.total : null,
    apiMissRate24h: slice.total24h > 0 ? slice.apiMiss24h / slice.total24h : null,
    agreementRate: rates.agreementRate,
    bars: evaluateFlipBars({
      total: slice.total,
      agreementRate: rates.agreementRate,
      midBandRate: rates.midBandRate,
    }),
    kill: killForCounts(slice),
  }
}

const FLIP_COUNT_SQL = `
  COUNT(*)::int AS total,
  COUNT(*) FILTER (WHERE band = 'mid')::int AS mid_band,
  COUNT(*) FILTER (WHERE band = 'api_miss')::int AS api_miss,
  COUNT(*) FILTER (
    WHERE decision_shadow IN ('keep', 'suppress')
  )::int AS agreement_eligible,
  COUNT(*) FILTER (
    WHERE decision_shadow IN ('keep', 'suppress')
      AND decision_shadow = decision_spec
  )::int AS agreement_matches,
  COUNT(*) FILTER (
    WHERE predicted_at >= NOW() - INTERVAL '24 hours'
  )::int AS total_24h,
  COUNT(*) FILTER (
    WHERE band = 'api_miss'
      AND predicted_at >= NOW() - INTERVAL '24 hours'
  )::int AS api_miss_24h,
  COUNT(*) FILTER (
    WHERE decision_shadow IN ('keep', 'suppress')
      AND predicted_at >= NOW() - INTERVAL '24 hours'
  )::int AS agreement_eligible_24h,
  COUNT(*) FILTER (
    WHERE decision_shadow IN ('keep', 'suppress')
      AND decision_shadow = decision_spec
      AND predicted_at >= NOW() - INTERVAL '24 hours'
  )::int AS agreement_matches_24h
`

type FlipCountRow = {
  total: string | number
  mid_band: string | number
  api_miss: string | number
  agreement_eligible: string | number
  agreement_matches: string | number
  total_24h: string | number
  api_miss_24h: string | number
  agreement_eligible_24h: string | number
  agreement_matches_24h: string | number
}

function countsFromRow(r: FlipCountRow): NoulFlipWindowCounts {
  return {
    total: Number(r.total) || 0,
    midBand: Number(r.mid_band) || 0,
    apiMiss: Number(r.api_miss) || 0,
    agreementEligible: Number(r.agreement_eligible) || 0,
    agreementMatches: Number(r.agreement_matches) || 0,
    total24h: Number(r.total_24h) || 0,
    apiMiss24h: Number(r.api_miss_24h) || 0,
    agreementEligible24h: Number(r.agreement_eligible_24h) || 0,
    agreementMatches24h: Number(r.agreement_matches_24h) || 0,
  }
}

/**
 * All-time shadow sample vs #54 flip bars (N≥500, A≥85%, M≤20%),
 * split by strategy_key and first_seen / at_80 arm families.
 */
export async function loadEarlyEnterNoulFlipReadiness(): Promise<EarlyEnterNoulFlipReadiness> {
  const barsSpec = {
    nMin: FLIP_N_MIN,
    agreementMin: FLIP_AGREEMENT_MIN,
    midMax: FLIP_MID_MAX,
  }
  const killSpec = {
    apiMissMax: getApiMissKillRate(),
    disagreementMax: getDisagreementKillRate(),
    minN: KILL_SWITCH_MIN_N,
  }
  const emptySlice = emptyFlipCounts()
  const emptyMetrics = flipMetrics(emptySlice)
  const emptyOverall: EarlyEnterNoulFlipReadiness['overall'] = {
    arm: 'all',
    ...emptySlice,
    ...emptyMetrics,
  }
  const emptyArm = (
    arm: FlipArmFamily,
  ): EarlyEnterNoulFlipArmStats => ({
    arm,
    ...emptySlice,
    ...emptyMetrics,
  })

  try {
    await ensureEarlyEnterNoulShadowTable()
    const { rows } = await query<FlipCountRow & { strategy_key: string }>(
      `SELECT
         strategy_key,
         ${FLIP_COUNT_SQL}
       FROM early_enter_noul_shadow
       GROUP BY strategy_key
       ORDER BY strategy_key`,
    )

    const byStrategy: EarlyEnterNoulFlipStrategyStats[] = rows.map((r) => {
      const counts = countsFromRow(r)
      const metrics = flipMetrics(counts)
      return {
        strategyKey: r.strategy_key,
        ...counts,
        ...metrics,
        arm: flipArmFamilyFromStrategyKey(r.strategy_key),
      }
    })

    const armOrder: FlipArmFamily[] = ['first_seen', 'at_80']
    const byArm: EarlyEnterNoulFlipArmStats[] = armOrder.map((arm) => {
      const members = byStrategy.filter((s) => s.arm === arm)
      const counts = members.reduce(
        (acc, s) => addFlipCounts(acc, s),
        emptyFlipCounts(),
      )
      return {
        arm,
        ...counts,
        ...flipMetrics(counts),
      }
    })

    const overallCounts = byStrategy.reduce(
      (acc, s) => addFlipCounts(acc, s),
      emptyFlipCounts(),
    )
    const overall: EarlyEnterNoulFlipReadiness['overall'] = {
      arm: 'all',
      ...overallCounts,
      ...flipMetrics(overallCounts),
    }

    return {
      bars: barsSpec,
      kill: killSpec,
      overall,
      byArm,
      byStrategy,
    }
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return {
        bars: barsSpec,
        kill: killSpec,
        overall: emptyOverall,
        byArm: [emptyArm('first_seen'), emptyArm('at_80')],
        byStrategy: [],
      }
    }
    console.error('[early-enter-noul-shadow] flip readiness failed:', error)
    return {
      bars: barsSpec,
      kill: killSpec,
      overall: emptyOverall,
      byArm: [],
      byStrategy: [],
    }
  }
}

let killCache: { at: number; tripped: boolean } | null = null
const KILL_CACHE_MS = 60_000

/**
 * True when all-time or 24h api_miss / disagreement exceeds the kill thresholds.
 * Failures that hide the sample hold soft-active off. Missing schema is an empty
 * sample (not a spike). Never enables soft-active.
 */
export async function isEarlyEnterNoulKillTripped(): Promise<boolean> {
  const now = Date.now()
  if (killCache && now - killCache.at < KILL_CACHE_MS) return killCache.tripped
  try {
    const readiness = await loadEarlyEnterNoulFlipReadiness()
    const tripped = readiness.overall.kill?.tripped === true
    killCache = { at: now, tripped }
    return tripped
  } catch {
    killCache = { at: now, tripped: true }
    return true
  }
}

/** Test helper — reset ensure cache between tests if needed. */
export function resetEarlyEnterNoulShadowDbEnsureForTests(): void {
  ensurePromise = null
  killCache = null
}
