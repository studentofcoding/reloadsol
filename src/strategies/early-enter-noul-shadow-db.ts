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
  applyVacuousFlipAgreement,
  closedLoopPopulationVariance,
  evaluateFlipBars,
  evaluateKillSwitchWindow,
  filterReasonFromBand,
  flipBarsWithMissKill,
  isVacuousFlipAgreement,
  noulFlipSampleRates,
  flipArmFamilyFromStrategyKey,
  getApiMissKillRate,
  getDisagreementKillRate,
  isNoulShadowBand,
  mergeKillSwitches,
  parseEarlyEnterNoulTokenPeakSort,
  strategyKeysForArmFamily,
  FLIP_AGREEMENT_MIN,
  FLIP_MID_MAX,
  FLIP_N_MIN,
  KILL_SWITCH_MIN_N,
  type EarlyEnterNoulTokenPeakSort,
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
 * Agreement is keep/suppress only — api_miss (follow_spec) is excluded from A.
 * Mid-band rate = band mid / non-miss rows. miss% is api_miss / all rows.
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
             AND band <> 'api_miss'
         )::int AS agreement_eligible,
         COUNT(*) FILTER (
           WHERE decision_shadow IN ('keep', 'suppress')
             AND band <> 'api_miss'
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
      const rates = noulFlipSampleRates({
        total,
        midBand,
        apiMiss,
        agreementEligible,
        agreementMatches,
      })
      return {
        strategyKey: r.strategy_key,
        total,
        midBand,
        midBandRate: rates.midBandRate,
        apiMiss,
        apiMissRate: rates.apiMissRate,
        agreementEligible,
        agreementMatches,
        agreementRate: rates.agreementRate,
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
  /** band = keep. Zero keeps makes 100% agreement vacuous. */
  keepCount: number
  clScoreN: number
  clScoreSum: number
  clScoreSumSq: number
  clScoreMin: number | null
  clScoreMax: number | null
  /** Closed-loop scores ≥ EARLY_ENTER_ML_MIN (0.55). */
  clScoreGeGate: number
}

export type EarlyEnterNoulFlipStrategyStats = EarlyEnterNoulCompareStats &
  NoulFlipWindowCounts & {
    apiMissRate24h: number | null
    arm: FlipArmFamily | null
    clScoreVariance: number | null
    vacuousAgreement: boolean
    bars: FlipBarCheck
    kill: KillSwitchCheck
  }

export type EarlyEnterNoulFlipArmStats = NoulFlipWindowCounts & {
  arm: FlipArmFamily | 'all'
  midBandRate: number | null
  apiMissRate: number | null
  apiMissRate24h: number | null
  agreementRate: number | null
  clScoreVariance: number | null
  vacuousAgreement: boolean
  bars: FlipBarCheck
  kill: KillSwitchCheck
}

export type EarlyEnterNoulFlipReadiness = {
  bars: {
    nMin: number
    agreementMin: number
    midMax: number
  }
  /** #54 miss% kill. Above the max blocks flip and holds soft-active off. Does not enable it. */
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

function ratesFromCounts(slice: NoulFlipWindowCounts) {
  return noulFlipSampleRates({
    total: slice.total,
    midBand: slice.midBand,
    apiMiss: slice.apiMiss,
    agreementEligible: slice.agreementEligible,
    agreementMatches: slice.agreementMatches,
  })
}

function mergeBound(
  a: number | null,
  b: number | null,
  pick: (x: number, y: number) => number,
): number | null {
  if (a == null) return b
  if (b == null) return a
  return pick(a, b)
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
    keepCount: 0,
    clScoreN: 0,
    clScoreSum: 0,
    clScoreSumSq: 0,
    clScoreMin: null,
    clScoreMax: null,
    clScoreGeGate: 0,
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
    keepCount: a.keepCount + b.keepCount,
    clScoreN: a.clScoreN + b.clScoreN,
    clScoreSum: a.clScoreSum + b.clScoreSum,
    clScoreSumSq: a.clScoreSumSq + b.clScoreSumSq,
    clScoreMin: mergeBound(a.clScoreMin, b.clScoreMin, Math.min),
    clScoreMax: mergeBound(a.clScoreMax, b.clScoreMax, Math.max),
    clScoreGeGate: a.clScoreGeGate + b.clScoreGeGate,
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
  clScoreVariance: number | null
  vacuousAgreement: boolean
  bars: FlipBarCheck
  kill: KillSwitchCheck
} {
  const rates = ratesFromCounts(slice)
  const kill = killForCounts(slice)
  const clScoreVariance = closedLoopPopulationVariance(
    slice.clScoreN,
    slice.clScoreSum,
    slice.clScoreSumSq,
  )
  const vacuousAgreement = isVacuousFlipAgreement({
    keepCount: slice.keepCount,
    clScoreN: slice.clScoreN,
    clScoreVariance,
  })
  const bars = applyVacuousFlipAgreement(
    flipBarsWithMissKill(
      evaluateFlipBars({
        total: slice.total,
        agreementRate: rates.agreementRate,
        midBandRate: rates.midBandRate,
        apiMissRate: rates.apiMissRate,
        apiMissMax: getApiMissKillRate(),
      }),
      kill.apiMissSpike,
    ),
    vacuousAgreement,
  )
  return {
    midBandRate: rates.midBandRate,
    apiMissRate: rates.apiMissRate,
    apiMissRate24h: slice.total24h > 0 ? slice.apiMiss24h / slice.total24h : null,
    agreementRate: rates.agreementRate,
    clScoreVariance,
    vacuousAgreement,
    bars,
    kill,
  }
}

const FLIP_COUNT_SQL = `
  COUNT(*)::int AS total,
  COUNT(*) FILTER (WHERE band = 'mid')::int AS mid_band,
  COUNT(*) FILTER (WHERE band = 'api_miss')::int AS api_miss,
  COUNT(*) FILTER (
    WHERE decision_shadow IN ('keep', 'suppress')
      AND band <> 'api_miss'
  )::int AS agreement_eligible,
  COUNT(*) FILTER (
    WHERE decision_shadow IN ('keep', 'suppress')
      AND band <> 'api_miss'
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
      AND band <> 'api_miss'
      AND predicted_at >= NOW() - INTERVAL '24 hours'
  )::int AS agreement_eligible_24h,
  COUNT(*) FILTER (
    WHERE decision_shadow IN ('keep', 'suppress')
      AND band <> 'api_miss'
      AND decision_shadow = decision_spec
      AND predicted_at >= NOW() - INTERVAL '24 hours'
  )::int AS agreement_matches_24h,
  COUNT(*) FILTER (WHERE band = 'keep')::int AS keep_count,
  COUNT(cl_ml_score)::int AS cl_score_n,
  COALESCE(SUM(cl_ml_score), 0)::float8 AS cl_score_sum,
  COALESCE(SUM(cl_ml_score * cl_ml_score), 0)::float8 AS cl_score_sumsq,
  MIN(cl_ml_score) AS cl_score_min,
  MAX(cl_ml_score) AS cl_score_max,
  COUNT(*) FILTER (WHERE cl_ml_score >= 0.55)::int AS cl_score_ge_gate
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
  keep_count: string | number
  cl_score_n: string | number
  cl_score_sum: string | number
  cl_score_sumsq: string | number
  cl_score_min: string | number | null
  cl_score_max: string | number | null
  cl_score_ge_gate: string | number
}

function numOrNull(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
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
    keepCount: Number(r.keep_count) || 0,
    clScoreN: Number(r.cl_score_n) || 0,
    clScoreSum: Number(r.cl_score_sum) || 0,
    clScoreSumSq: Number(r.cl_score_sumsq) || 0,
    clScoreMin: numOrNull(r.cl_score_min),
    clScoreMax: numOrNull(r.cl_score_max),
    clScoreGeGate: Number(r.cl_score_ge_gate) || 0,
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
 * True when all-time or 24h miss% exceeds the kill threshold.
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

export type { EarlyEnterNoulTokenPeakSort }

export type EarlyEnterNoulTokenPeakSlice = {
  /** Unique shadow mints in this slice (with or without a tracker peak). */
  uniqueMints: number
  withPeak: number
  medianPeakPercent: number | null
  avgPeakPercent: number | null
  /** Mints whose tracker peak is at least +100%. */
  hit100: number
  /** hit100 / withPeak. Null when no mint in the slice has a peak. */
  hit100Rate: number | null
}

export type EarlyEnterNoulTokenPeakBandStats = EarlyEnterNoulTokenPeakSlice & {
  band: NoulShadowBand
}

export type EarlyEnterNoulTokenPeakArmStats = EarlyEnterNoulTokenPeakSlice & {
  arm: FlipArmFamily | 'other'
}

export type EarlyEnterNoulTokenPeakMint = {
  tokenAddress: string
  symbol: string | null
  chain: string
  firstPredictedAt: string
  latestPredictedAt: string
  firstBand: NoulShadowBand
  firstDecisionShadow: NoulShadowDecision
  firstDecisionSpec: NoulSpecDecision
  /** Mean cl_ml_score across shadow rows. Null when every row is null. */
  avgClMlScore: number | null
  /** cl_ml_score on the earliest shadow row. */
  firstClMlScore: number | null
  /** First non-null Noul on the mint. Null when Noul was never stored. */
  noul: number | null
  /** token_mcap_tracking.peak_growth_percent. Null when the tracker has no row. */
  peakGrowthPercent: number | null
  /** Arm of the earliest shadow row. */
  arm: FlipArmFamily | null
  firstStrategyKey: string
}

export type EarlyEnterNoulTokenPeaks = EarlyEnterNoulTokenPeakSlice & {
  /**
   * Average peak among mints that have any shadow row with strategy_key LIKE '%at_80%'
   * and a tracker peak. Distinct from the first-arm at_80 breakdown.
   */
  at80AvgPeakPercent: number | null
  at80WithPeak: number
  at80Mints: number
  byFirstBand: EarlyEnterNoulTokenPeakBandStats[]
  byFirstArm: EarlyEnterNoulTokenPeakArmStats[]
  mints: EarlyEnterNoulTokenPeakMint[]
  total: number
  limit: number
  offset: number
  sort: EarlyEnterNoulTokenPeakSort
}

const TOKEN_PEAK_BAND_ORDER: NoulShadowBand[] = [
  'suppress',
  'keep',
  'mid',
  'skipped_null',
  'api_miss',
]

const TOKEN_PEAK_ORDER_SQL: Record<EarlyEnterNoulTokenPeakSort, string> = {
  peak_desc:
    'peak_growth_percent DESC NULLS LAST, latest_predicted_at DESC, token_address ASC',
  peak_asc:
    'peak_growth_percent ASC NULLS LAST, latest_predicted_at DESC, token_address ASC',
  predicted_desc: 'latest_predicted_at DESC, token_address ASC',
  predicted_asc: 'latest_predicted_at ASC, token_address ASC',
}

/**
 * One row per shadow mint. First* columns are the earliest shadow row.
 * Peak comes from token_mcap_tracking on token_address (table primary key).
 * Read-only. Historical rows stay until new emits; this query does not backfill.
 */
const TOKEN_PEAK_MINTS_CTE = `
WITH firsts AS (
  SELECT DISTINCT ON (token_address)
    token_address,
    symbol AS first_symbol,
    chain,
    predicted_at AS first_predicted_at,
    band AS first_band,
    decision_shadow AS first_decision_shadow,
    decision_spec AS first_decision_spec,
    strategy_key AS first_strategy_key,
    cl_ml_score AS first_cl_ml_score
  FROM early_enter_noul_shadow
  ORDER BY token_address, predicted_at ASC, id ASC
),
aggs AS (
  SELECT
    token_address,
    MAX(predicted_at) AS latest_predicted_at,
    AVG(cl_ml_score) AS avg_cl_ml_score,
    BOOL_OR(strategy_key LIKE '%at_80%') AS seen_at_80,
    (ARRAY_AGG(symbol ORDER BY predicted_at DESC, id DESC)
      FILTER (WHERE symbol IS NOT NULL AND btrim(symbol) <> ''))[1] AS symbol,
    (ARRAY_AGG(noul ORDER BY predicted_at ASC, id ASC)
      FILTER (WHERE noul IS NOT NULL))[1] AS noul
  FROM early_enter_noul_shadow
  GROUP BY token_address
),
mints AS (
  SELECT
    f.token_address,
    COALESCE(a.symbol, f.first_symbol) AS symbol,
    f.chain,
    f.first_predicted_at,
    a.latest_predicted_at,
    f.first_band,
    f.first_decision_shadow,
    f.first_decision_spec,
    f.first_strategy_key,
    f.first_cl_ml_score,
    a.avg_cl_ml_score,
    a.noul,
    a.seen_at_80,
    CASE
      WHEN f.first_strategy_key LIKE '%first_seen%' THEN 'first_seen'
      WHEN f.first_strategy_key LIKE '%at_80%' THEN 'at_80'
      ELSE 'other'
    END AS first_arm,
    t.peak_growth_percent
  FROM firsts f
  JOIN aggs a ON a.token_address = f.token_address
  LEFT JOIN token_mcap_tracking t
    ON t.token_address = f.token_address
)
`

type TokenPeakGroupRow = {
  grouping_band: string | number
  grouping_arm: string | number
  first_band: string | null
  first_arm: string | null
  unique_mints: string | number
  with_peak: string | number
  median_peak: string | number | null
  avg_peak: string | number | null
  hit_100: string | number
  at80_avg_peak: string | number | null
  at80_with_peak: string | number
  at80_mints: string | number
}

type TokenPeakMintRow = {
  token_address: string
  symbol: string | null
  chain: string
  first_predicted_at: Date | string
  latest_predicted_at: Date | string
  first_band: string
  first_decision_shadow: string
  first_decision_spec: string
  first_strategy_key: string
  first_cl_ml_score: string | number | null
  avg_cl_ml_score: string | number | null
  noul: string | number | null
  peak_growth_percent: string | number | null
}

function intOrZero(value: string | number | null | undefined): number {
  const n = numOrNull(value)
  return n == null ? 0 : Math.trunc(n)
}

function isoTimestamp(value: Date | string): string {
  if (value instanceof Date) return value.toISOString()
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString()
}

function emptyPeakSlice(): EarlyEnterNoulTokenPeakSlice {
  return {
    uniqueMints: 0,
    withPeak: 0,
    medianPeakPercent: null,
    avgPeakPercent: null,
    hit100: 0,
    hit100Rate: null,
  }
}

function sliceFromGroup(row: TokenPeakGroupRow): EarlyEnterNoulTokenPeakSlice {
  const withPeak = intOrZero(row.with_peak)
  const hit100 = intOrZero(row.hit_100)
  return {
    uniqueMints: intOrZero(row.unique_mints),
    withPeak,
    medianPeakPercent: numOrNull(row.median_peak),
    avgPeakPercent: numOrNull(row.avg_peak),
    hit100,
    hit100Rate: withPeak > 0 ? hit100 / withPeak : null,
  }
}

function asShadowDecision(value: string): NoulShadowDecision | null {
  if (value === 'keep' || value === 'suppress' || value === 'follow_spec') return value
  return null
}

function asSpecDecision(value: string): NoulSpecDecision | null {
  if (value === 'keep' || value === 'suppress') return value
  return null
}

function emptyTokenPeaks(opts: {
  limit: number
  offset: number
  sort: EarlyEnterNoulTokenPeakSort
}): EarlyEnterNoulTokenPeaks {
  return {
    ...emptyPeakSlice(),
    at80AvgPeakPercent: null,
    at80WithPeak: 0,
    at80Mints: 0,
    byFirstBand: TOKEN_PEAK_BAND_ORDER.map((band) => ({
      band,
      ...emptyPeakSlice(),
    })),
    byFirstArm: [
      { arm: 'first_seen', ...emptyPeakSlice() },
      { arm: 'at_80', ...emptyPeakSlice() },
    ],
    mints: [],
    total: 0,
    limit: opts.limit,
    offset: opts.offset,
    sort: opts.sort,
  }
}

export type LoadEarlyEnterNoulShadowTokenPeaksOpts = {
  limit?: number
  offset?: number
  sort?: EarlyEnterNoulTokenPeakSort | null
}

/**
 * All-time unique shadow mints plus tracker peak outcomes.
 * Independent of the funnel hours window. Paginated; `total` is the full mint count.
 */
export async function loadEarlyEnterNoulShadowTokenPeaks(
  opts: LoadEarlyEnterNoulShadowTokenPeaksOpts = {},
): Promise<EarlyEnterNoulTokenPeaks> {
  const sort = parseEarlyEnterNoulTokenPeakSort(opts.sort)
  const limitRaw = opts.limit ?? 100
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), 500)
      : 100
  const offsetRaw = opts.offset ?? 0
  const offset =
    Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0
  const empty = emptyTokenPeaks({ limit, offset, sort })

  try {
    await ensureEarlyEnterNoulShadowTable()
    const orderSql = TOKEN_PEAK_ORDER_SQL[sort]
    const [summary, list] = await Promise.all([
      query<TokenPeakGroupRow>(
        `${TOKEN_PEAK_MINTS_CTE}
         SELECT
           GROUPING(first_band) AS grouping_band,
           GROUPING(first_arm) AS grouping_arm,
           first_band,
           first_arm,
           COUNT(*)::int AS unique_mints,
           COUNT(*) FILTER (WHERE peak_growth_percent IS NOT NULL)::int AS with_peak,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY peak_growth_percent)
             FILTER (WHERE peak_growth_percent IS NOT NULL) AS median_peak,
           AVG(peak_growth_percent) FILTER (WHERE peak_growth_percent IS NOT NULL) AS avg_peak,
           COUNT(*) FILTER (WHERE peak_growth_percent >= 100)::int AS hit_100,
           AVG(peak_growth_percent) FILTER (
             WHERE seen_at_80 AND peak_growth_percent IS NOT NULL
           ) AS at80_avg_peak,
           COUNT(*) FILTER (
             WHERE seen_at_80 AND peak_growth_percent IS NOT NULL
           )::int AS at80_with_peak,
           COUNT(*) FILTER (WHERE seen_at_80)::int AS at80_mints
         FROM mints
         GROUP BY GROUPING SETS ((), (first_band), (first_arm))`,
      ),
      query<TokenPeakMintRow>(
        `${TOKEN_PEAK_MINTS_CTE}
         SELECT
           token_address,
           symbol,
           chain,
           first_predicted_at,
           latest_predicted_at,
           first_band,
           first_decision_shadow,
           first_decision_spec,
           first_strategy_key,
           first_cl_ml_score,
           avg_cl_ml_score,
           noul,
           peak_growth_percent
         FROM mints
         ORDER BY ${orderSql}
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
    ])

    const overall = summary.rows.find(
      (row) => intOrZero(row.grouping_band) === 1 && intOrZero(row.grouping_arm) === 1,
    )
    const byBand = new Map<NoulShadowBand, EarlyEnterNoulTokenPeakSlice>()
    const byArm = new Map<string, EarlyEnterNoulTokenPeakSlice>()
    for (const row of summary.rows) {
      const slice = sliceFromGroup(row)
      if (intOrZero(row.grouping_band) === 0 && row.first_band && isNoulShadowBand(row.first_band)) {
        byBand.set(row.first_band, slice)
      }
      if (intOrZero(row.grouping_arm) === 0 && row.first_arm) {
        byArm.set(row.first_arm, slice)
      }
    }

    const base = overall ? sliceFromGroup(overall) : emptyPeakSlice()
    const armOrder: Array<FlipArmFamily | 'other'> = ['first_seen', 'at_80', 'other']
    const byFirstArm = armOrder
      .filter((arm) => arm !== 'other' || (byArm.get('other')?.uniqueMints ?? 0) > 0)
      .map((arm) => ({
        arm,
        ...(byArm.get(arm) ?? emptyPeakSlice()),
      }))

    const mints: EarlyEnterNoulTokenPeakMint[] = []
    for (const row of list.rows) {
      const firstBand = isNoulShadowBand(row.first_band) ? row.first_band : null
      const firstDecisionShadow = asShadowDecision(row.first_decision_shadow)
      const firstDecisionSpec = asSpecDecision(row.first_decision_spec)
      if (!firstBand || !firstDecisionShadow || !firstDecisionSpec) continue
      mints.push({
        tokenAddress: row.token_address,
        symbol: row.symbol ?? null,
        chain: row.chain,
        firstPredictedAt: isoTimestamp(row.first_predicted_at),
        latestPredictedAt: isoTimestamp(row.latest_predicted_at),
        firstBand,
        firstDecisionShadow,
        firstDecisionSpec,
        avgClMlScore: numOrNull(row.avg_cl_ml_score),
        firstClMlScore: numOrNull(row.first_cl_ml_score),
        noul: numOrNull(row.noul),
        peakGrowthPercent: numOrNull(row.peak_growth_percent),
        arm: flipArmFamilyFromStrategyKey(row.first_strategy_key),
        firstStrategyKey: row.first_strategy_key,
      })
    }

    return {
      ...base,
      at80AvgPeakPercent: overall ? numOrNull(overall.at80_avg_peak) : null,
      at80WithPeak: overall ? intOrZero(overall.at80_with_peak) : 0,
      at80Mints: overall ? intOrZero(overall.at80_mints) : 0,
      byFirstBand: TOKEN_PEAK_BAND_ORDER.map((band) => ({
        band,
        ...(byBand.get(band) ?? emptyPeakSlice()),
      })),
      byFirstArm,
      mints,
      total: base.uniqueMints,
      limit,
      offset,
      sort,
    }
  } catch (error) {
    if (isMissingSchemaError(error)) return empty
    console.error('[early-enter-noul-shadow] token peaks failed:', error)
    return empty
  }
}
