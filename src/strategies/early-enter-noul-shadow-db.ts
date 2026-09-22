/**
 * DB access for early_enter_noul_shadow (SPEC-jev-soft-gate-shadow-v1).
 * Fail-soft on missing schema — never throw past Early Enter emit.
 */

import { query } from '@/utils/db'
import { isMissingSchemaError } from '@/utils/db-health'
import type { AppNetwork } from '@/utils/app-network'
import type {
  EarlyEnterNoulStrategyKey,
  NoulShadowBand,
  NoulShadowDecision,
  NoulSpecDecision,
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

/** Test helper — reset ensure cache between tests if needed. */
export function resetEarlyEnterNoulShadowDbEnsureForTests(): void {
  ensurePromise = null
}
