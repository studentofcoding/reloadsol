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
  filterReasonFromBand,
  flipArmFamilyFromStrategyKey,
  isNoulShadowBand,
  strategyKeysForArmFamily,
  FLIP_AGREEMENT_MIN,
  FLIP_MID_MAX,
  FLIP_N_MIN,
  type FlipArmFamily,
  type FlipBarCheck,
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
  /** Rows with decision_shadow in {keep,suppress} (excludes follow_spec / skipped_null soft-fail). */
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
      agreement_eligible: string | number
      agreement_matches: string | number
    }>(
      `SELECT
         strategy_key,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE band = 'mid')::int AS mid_band,
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
      const agreementEligible = Number(r.agreement_eligible) || 0
      const agreementMatches = Number(r.agreement_matches) || 0
      return {
        strategyKey: r.strategy_key,
        total,
        midBand,
        midBandRate: total > 0 ? midBand / total : null,
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

export type EarlyEnterNoulFlipStrategyStats = EarlyEnterNoulCompareStats & {
  arm: FlipArmFamily | null
  bars: FlipBarCheck
}

export type EarlyEnterNoulFlipArmStats = {
  arm: FlipArmFamily
  total: number
  midBand: number
  midBandRate: number | null
  agreementEligible: number
  agreementMatches: number
  agreementRate: number | null
  bars: FlipBarCheck
}

export type EarlyEnterNoulFlipReadiness = {
  bars: {
    nMin: number
    agreementMin: number
    midMax: number
  }
  /** All-time rows across every strategy_key. */
  overall: EarlyEnterNoulFlipArmStats & { arm: 'all' }
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
  const emptyOverall: EarlyEnterNoulFlipReadiness['overall'] = {
    arm: 'all',
    total: 0,
    midBand: 0,
    midBandRate: null,
    agreementEligible: 0,
    agreementMatches: 0,
    agreementRate: null,
    bars: evaluateFlipBars({
      total: 0,
      agreementRate: null,
      midBandRate: null,
    }),
  }

  try {
    await ensureEarlyEnterNoulShadowTable()
    const { rows } = await query<{
      strategy_key: string
      total: string | number
      mid_band: string | number
      agreement_eligible: string | number
      agreement_matches: string | number
    }>(
      `SELECT
         strategy_key,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE band = 'mid')::int AS mid_band,
         COUNT(*) FILTER (
           WHERE decision_shadow IN ('keep', 'suppress')
         )::int AS agreement_eligible,
         COUNT(*) FILTER (
           WHERE decision_shadow IN ('keep', 'suppress')
             AND decision_shadow = decision_spec
         )::int AS agreement_matches
       FROM early_enter_noul_shadow
       GROUP BY strategy_key
       ORDER BY strategy_key`,
    )

    const byStrategy: EarlyEnterNoulFlipStrategyStats[] = rows.map((r) => {
      const total = Number(r.total) || 0
      const midBand = Number(r.mid_band) || 0
      const agreementEligible = Number(r.agreement_eligible) || 0
      const agreementMatches = Number(r.agreement_matches) || 0
      const rates = ratesFromCounts({
        total,
        midBand,
        agreementEligible,
        agreementMatches,
      })
      return {
        strategyKey: r.strategy_key,
        total,
        midBand,
        midBandRate: rates.midBandRate,
        agreementEligible,
        agreementMatches,
        agreementRate: rates.agreementRate,
        arm: flipArmFamilyFromStrategyKey(r.strategy_key),
        bars: evaluateFlipBars({
          total,
          agreementRate: rates.agreementRate,
          midBandRate: rates.midBandRate,
        }),
      }
    })

    const armOrder: FlipArmFamily[] = ['first_seen', 'at_80']
    const byArm: EarlyEnterNoulFlipArmStats[] = armOrder.map((arm) => {
      const members = byStrategy.filter((s) => s.arm === arm)
      const total = members.reduce((n, s) => n + s.total, 0)
      const midBand = members.reduce((n, s) => n + s.midBand, 0)
      const agreementEligible = members.reduce(
        (n, s) => n + s.agreementEligible,
        0,
      )
      const agreementMatches = members.reduce(
        (n, s) => n + s.agreementMatches,
        0,
      )
      const rates = ratesFromCounts({
        total,
        midBand,
        agreementEligible,
        agreementMatches,
      })
      return {
        arm,
        total,
        midBand,
        midBandRate: rates.midBandRate,
        agreementEligible,
        agreementMatches,
        agreementRate: rates.agreementRate,
        bars: evaluateFlipBars({
          total,
          agreementRate: rates.agreementRate,
          midBandRate: rates.midBandRate,
        }),
      }
    })

    const total = byStrategy.reduce((n, s) => n + s.total, 0)
    const midBand = byStrategy.reduce((n, s) => n + s.midBand, 0)
    const agreementEligible = byStrategy.reduce(
      (n, s) => n + s.agreementEligible,
      0,
    )
    const agreementMatches = byStrategy.reduce(
      (n, s) => n + s.agreementMatches,
      0,
    )
    const overallRates = ratesFromCounts({
      total,
      midBand,
      agreementEligible,
      agreementMatches,
    })
    const overall: EarlyEnterNoulFlipReadiness['overall'] = {
      arm: 'all',
      total,
      midBand,
      midBandRate: overallRates.midBandRate,
      agreementEligible,
      agreementMatches,
      agreementRate: overallRates.agreementRate,
      bars: evaluateFlipBars({
        total,
        agreementRate: overallRates.agreementRate,
        midBandRate: overallRates.midBandRate,
      }),
    }

    return {
      bars: barsSpec,
      overall,
      byArm,
      byStrategy,
    }
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return {
        bars: barsSpec,
        overall: emptyOverall,
        byArm: [
          {
            arm: 'first_seen',
            total: 0,
            midBand: 0,
            midBandRate: null,
            agreementEligible: 0,
            agreementMatches: 0,
            agreementRate: null,
            bars: evaluateFlipBars({
              total: 0,
              agreementRate: null,
              midBandRate: null,
            }),
          },
          {
            arm: 'at_80',
            total: 0,
            midBand: 0,
            midBandRate: null,
            agreementEligible: 0,
            agreementMatches: 0,
            agreementRate: null,
            bars: evaluateFlipBars({
              total: 0,
              agreementRate: null,
              midBandRate: null,
            }),
          },
        ],
        byStrategy: [],
      }
    }
    console.error('[early-enter-noul-shadow] flip readiness failed:', error)
    return {
      bars: barsSpec,
      overall: emptyOverall,
      byArm: [],
      byStrategy: [],
    }
  }
}

/** Test helper — reset ensure cache between tests if needed. */
export function resetEarlyEnterNoulShadowDbEnsureForTests(): void {
  ensurePromise = null
}
