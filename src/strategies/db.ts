import { query, queryOne } from '@/utils/db'
import { isMissingSchemaError } from '@/utils/db-health'
import {
  readWalletRecordsCache,
  walletRecordsCacheKey,
  writeWalletRecordsCache,
} from '@/utils/wallet-records-cache'
import { getTrackingHealthStats, computeMcapSimPnlPct } from '@/utils/mcap-tracker'
import { getOpenMcapSimPositions } from '@/utils/mcap-sim-track'
import { readTokenSymbol, readTrainingClass } from './outcome-features'
import { dedupeStrategyOutcomeRows } from './outcome-dedupe'
import { outcomeCountsAsTradeSql } from './outcome-exclusions'
import { resolveStrategyFamily } from './strategy-family'
import { toNum, type TokenPnlRow } from './token-pnl-export'
import { buildShadowExecutionRecordForCost } from './sim-fill'
import { runConsensusTest, type ConsensusTestResult } from './consensus-test'
import {
  consensusGateMode,
  decideConsensusGate,
  getConsensusMinFamilies,
  type ConsensusGateDecision,
  type ConsensusShadowRow,
} from './consensus-gate'
import { applyAutoOutcomeLabels } from './outcome-labeling'
import { matchesTrainingClassFilter } from './ml-training-features'
import {
  monitorSnapshotsToChartPoints,
  priceHistoryToMonitorSnapshots,
  readMonitorSnapshotsFromFeatures,
  enrichFeaturesWithMonitorSnapshots,
} from './entry-feature-snapshot'
import { fetchTrackerTokenMetrics } from './sim-monitor-snapshots'
import {
  countVolumePoints,
  filterPointsToWindow,
  hasVolumeOnPoints,
  lastSnapshotVolume,
  mergeVolumeFromMonitorSnapshots,
  parsePriceHistory,
  readVolumeFromFeatures,
  shouldSkipTrackerForDomain,
  shouldUseTrackerHistoryFirst,
  trackerHistoryHasVolume,
} from './trade-window-chart-data'
import { isOpenTrackerPosition, resolveTrackerStrategyId } from '@/utils/trading-simulation'
import { coerceIsoTimestamp } from '@/utils/datetime'
import {
  computeBestTradeWindows,
  DEFAULT_REPORT_TIMEZONE,
  resolveReportTimeZone,
} from './best-trade-windows'
import { parseStrategyChain } from './types'
import { summarizeClosedPnls } from './close-outcome-status'
import type {
  StrategyChain,
  StrategyDefinitionRow,
  StrategyDomain,
  StrategyOutcomeRow,
  StrategyReportBreakdown,
  StrategyCoverageRow,
  TrendingBotStrategyOverride,
  ExecutionMode,
  OutcomeChartSource,
  OutcomeChartPoint,
  MlLabelStats,
  McapTrackerMilestoneBucket,
  McapOpenSimReportRow,
  McapTrackerReportStats,
  StrategyBestTradeWindows,
  StrategyOverlapRow,
  StrategyPairOverlapRow,
  PaperCapitalSummary,
} from './types'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let ensureChainColumnsPromise: Promise<void> | null = null

/** Idempotent guard so chain reads/writes work before 24-strategy-chain.sql is applied. */
async function ensureStrategyChainColumns(): Promise<void> {
  if (!ensureChainColumnsPromise) {
    ensureChainColumnsPromise = (async () => {
      await query(
        `ALTER TABLE strategy_definitions ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'sol'`,
      )
      await query(
        `ALTER TABLE strategy_outcomes ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'sol'`,
      )
    })()
      .then(() => undefined)
      .catch((err) => {
        ensureChainColumnsPromise = null
        throw err
      })
  }
  await ensureChainColumnsPromise
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return String(value ?? '')
}

function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null
  return toIso(value)
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>
  }
  return {}
}

function mapStrategyDefinitionRow(row: Record<string, unknown>): StrategyDefinitionRow {
  return {
    id: String(row.id),
    domain: row.domain as StrategyDomain,
    chain: parseStrategyChain(row.chain),
    name: String(row.name),
    description: row.description != null ? String(row.description) : null,
    config: parseJsonObject(row.config),
    is_active: Boolean(row.is_active),
    execution_mode: row.execution_mode as ExecutionMode,
    version: Number(row.version ?? 1),
    updated_at: toIso(row.updated_at),
  }
}

function mapStrategyOutcomeRow(row: Record<string, unknown>): StrategyOutcomeRow {
  return {
    id: String(row.id),
    strategy_id: String(row.strategy_id),
    domain: row.domain as StrategyDomain,
    chain: parseStrategyChain(row.chain),
    token_address: row.token_address != null ? String(row.token_address) : null,
    entry_at: toIsoOrNull(row.entry_at),
    exit_at: toIsoOrNull(row.exit_at),
    pnl_pct: row.pnl_pct != null ? Number(row.pnl_pct) : null,
    status: row.status != null ? String(row.status) : null,
    is_simulated: Boolean(row.is_simulated),
    features:
      row.features != null ? parseJsonObject(row.features) : null,
    created_at: toIso(row.created_at),
  }
}

function getTrackerTableName(): string {
  return process.env.NODE_ENV === 'development'
    ? 'trending_token_tracker_dev'
    : 'trending_token_tracker'
}

type OutcomeFilterParams = {
  strategyId?: string
  strategyIds?: string[]
  domain?: StrategyDomain
  chain?: StrategyChain
  isSimulated?: boolean
  from?: string
  to?: string
  mlLabel?: string
  mlCondition?: string
  status?: string
  pnlMin?: number
  pnlMax?: number
  entryMcapBand?: string
  tokenAddress?: string
  /**
   * Bookkeeping rows (`features.close_reason = 'orphan_reconcile'`, see outcome-exclusions.ts) are
   * EXCLUDED unless this is true. They are administrative closes, not trade results.
   */
  includeNonTrade?: boolean
}

function buildOutcomeWhereClause(params: OutcomeFilterParams): {
  sql: string
  values: unknown[]
} {
  const conditions: string[] = []
  const values: unknown[] = []

  if (params.strategyIds && params.strategyIds.length > 0) {
    values.push(params.strategyIds)
    conditions.push(`strategy_id = ANY($${values.length}::text[])`)
  } else if (params.strategyId) {
    values.push(params.strategyId)
    conditions.push(`strategy_id = $${values.length}`)
  }
  if (params.domain) {
    values.push(params.domain)
    conditions.push(`domain = $${values.length}`)
  }
  if (params.chain) {
    values.push(params.chain)
    conditions.push(`chain = $${values.length}`)
  }
  if (params.isSimulated !== undefined) {
    values.push(params.isSimulated)
    conditions.push(`is_simulated = $${values.length}`)
  }
  if (params.from) {
    values.push(params.from)
    conditions.push(`exit_at >= $${values.length}`)
  }
  if (params.to) {
    values.push(params.to)
    conditions.push(`exit_at <= $${values.length}`)
  }
  if (params.mlLabel === 'unlabeled') {
    conditions.push(`(features->>'ml_label' IS NULL OR features->>'ml_label' = '')`)
  } else if (params.mlLabel) {
    values.push(params.mlLabel)
    conditions.push(`features->>'ml_label' = $${values.length}`)
  }
  if (params.mlCondition === 'none') {
    conditions.push(
      `(features->>'ml_condition' IS NULL OR features->>'ml_condition' = '')`,
    )
  } else if (params.mlCondition) {
    values.push(params.mlCondition)
    conditions.push(`features->>'ml_condition' = $${values.length}`)
  }
  if (params.status) {
    values.push(params.status)
    conditions.push(`status = $${values.length}`)
  }
  if (params.pnlMin !== undefined) {
    values.push(params.pnlMin)
    conditions.push(`pnl_pct >= $${values.length}`)
  }
  if (params.pnlMax !== undefined) {
    values.push(params.pnlMax)
    conditions.push(`pnl_pct <= $${values.length}`)
  }
  if (params.entryMcapBand) {
    values.push(params.entryMcapBand)
    conditions.push(`features->>'entry_mcap_band' = $${values.length}`)
  }
  if (params.tokenAddress) {
    const needle = params.tokenAddress.replace(/[%_\\]/g, '').trim()
    if (needle) {
      const looksFullCa =
        /^0x[a-fA-F0-9]{40}$/i.test(needle) ||
        (needle.length >= 32 &&
          needle.length <= 44 &&
          /^[1-9A-HJ-NP-Za-km-z]+$/.test(needle))
      if (looksFullCa) {
        // Full contract address → equality so the (chain, lower(address),
        // created_at) index serves the probe instead of an ILIKE seq scan.
        values.push(needle)
        const n = values.length
        conditions.push(`lower(token_address) = lower($${n})`)
      } else {
        values.push(`%${needle}%`)
        const n = values.length
        conditions.push(
          `(token_address ILIKE $${n} OR COALESCE(features->>'token_symbol','') ILIKE $${n} OR COALESCE(features->>'symbol','') ILIKE $${n})`,
        )
      }
    }
  }

  if (!params.includeNonTrade) conditions.push(outcomeCountsAsTradeSql())

  const sql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return { sql, values }
}

export async function loadStrategyDefinitionRows(
  domain?: StrategyDomain,
  chain?: StrategyChain,
): Promise<StrategyDefinitionRow[]> {
  try {
    await ensureStrategyChainColumns()
    const wheres: string[] = []
    const params: unknown[] = []
    if (domain) {
      params.push(domain)
      wheres.push(`domain = $${params.length}`)
    }
    if (chain) {
      params.push(chain)
      wheres.push(`chain = $${params.length}`)
    }
    const { rows } = await query<Record<string, unknown>>(
      `SELECT * FROM strategy_definitions${wheres.length ? ` WHERE ${wheres.join(' AND ')}` : ''}`,
      params,
    )
    return rows.map(mapStrategyDefinitionRow)
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return []
    }
    console.warn('[strategies/db] load failed:', errorMessage(error))
    return []
  }
}

export async function loadStrategyDefinitionById(
  id: string,
): Promise<StrategyDefinitionRow | null> {
  try {
    const row = await queryOne<Record<string, unknown>>(
      `SELECT * FROM strategy_definitions WHERE id = $1 LIMIT 1`,
      [id],
    )
    return row ? mapStrategyDefinitionRow(row) : null
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return null
    }
    console.warn('[strategies/db] load by id failed:', errorMessage(error))
    return null
  }
}

export async function upsertStrategyDefinition(params: {
  id: string
  domain: StrategyDomain
  /** Chain this definition belongs to. Defaults to 'sol'. */
  chain?: StrategyChain
  name: string
  description?: string | null
  config: Record<string, unknown>
  is_active: boolean
  execution_mode?: ExecutionMode
}): Promise<{ ok: boolean; error?: string }> {
  const updatedAt = new Date().toISOString()
  const configJson = JSON.stringify(params.config)
  // Omitted chain must not write NULL into a NOT NULL DEFAULT 'sol' column.
  const chain: StrategyChain = params.chain ?? 'sol'

  try {
    if (params.execution_mode) {
      await query(
        `INSERT INTO strategy_definitions (
           id, domain, chain, name, description, config, is_active, updated_at, execution_mode
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           domain = EXCLUDED.domain,
           chain = EXCLUDED.chain,
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           config = EXCLUDED.config,
           is_active = EXCLUDED.is_active,
           updated_at = EXCLUDED.updated_at,
           execution_mode = EXCLUDED.execution_mode`,
        [
          params.id,
          params.domain,
          chain,
          params.name,
          params.description ?? null,
          configJson,
          params.is_active,
          updatedAt,
          params.execution_mode,
        ],
      )
    } else {
      await query(
        `INSERT INTO strategy_definitions (
           id, domain, chain, name, description, config, is_active, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           domain = EXCLUDED.domain,
           chain = EXCLUDED.chain,
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           config = EXCLUDED.config,
           is_active = EXCLUDED.is_active,
           updated_at = EXCLUDED.updated_at`,
        [
          params.id,
          params.domain,
          chain,
          params.name,
          params.description ?? null,
          configJson,
          params.is_active,
          updatedAt,
        ],
      )
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

export { dedupeStrategyOutcomeRows, mcapSimClosedOutcomeKey } from './outcome-dedupe'

/** Mints that already have a strategy_outcomes row for this mcap strategy (one-shot). */
export async function loadMcapSimClosedOutcomeKeys(
  strategyId: string,
  tokenAddresses: string[],
): Promise<Set<string>> {
  if (tokenAddresses.length === 0) return new Set()

  try {
    const { rows } = await query<{ token_address: string }>(
      `SELECT DISTINCT token_address FROM strategy_outcomes
       WHERE strategy_id = $1
         AND domain = 'mcap_tracker'
         AND token_address = ANY($2::text[])`,
      [strategyId, tokenAddresses],
    )

    const keys = new Set<string>()
    for (const row of rows) {
      if (row.token_address) keys.add(row.token_address)
    }
    return keys
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return new Set()
    }
    console.warn(
      '[strategies/db] loadMcapSimClosedOutcomeKeys failed:',
      errorMessage(error),
    )
    return new Set()
  }
}

const REGIME_TAG_DATE = /^\d{4}-\d{2}-\d{2}$/

export async function loadRegimeTagForDate(tagDate: string): Promise<string | null> {
  // Date#toString().slice(0, 10) is "Wed Sep 02", which errors on a date column and spams logs.
  if (!REGIME_TAG_DATE.test(tagDate)) return null
  try {
    const row = await queryOne<{ regime_tag: string | null }>(
      `SELECT regime_tag FROM market_regime_tags WHERE tag_date = $1 LIMIT 1`,
      [tagDate],
    )
    return typeof row?.regime_tag === 'string' ? row.regime_tag : null
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return null
    }
    console.warn('[strategies/db] loadRegimeTagForDate failed:', errorMessage(error))
    return null
  }
}

export async function upsertMarketRegimeTag(params: {
  tagDate: string
  regimeTag: string
  notes?: string | null
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await query(
      `INSERT INTO market_regime_tags (tag_date, regime_tag, notes, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tag_date) DO UPDATE SET
         regime_tag = EXCLUDED.regime_tag,
         notes = EXCLUDED.notes,
         updated_at = EXCLUDED.updated_at`,
      [
        params.tagDate,
        params.regimeTag,
        params.notes ?? null,
        new Date().toISOString(),
      ],
    )
    return { ok: true }
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return { ok: false, error: 'market_regime_tags table missing' }
    }
    return { ok: false, error: errorMessage(error) }
  }
}

export async function listMarketRegimeTags(limit = 30): Promise<
  Array<{ tag_date: string; regime_tag: string; notes: string | null }>
> {
  try {
    const { rows } = await query<{
      tag_date: string
      regime_tag: string
      notes: string | null
    }>(
      `SELECT tag_date, regime_tag, notes FROM market_regime_tags
       ORDER BY tag_date DESC
       LIMIT $1`,
      [limit],
    )
    return rows.map((row) => ({
      tag_date: toIso(row.tag_date).slice(0, 10),
      regime_tag: String(row.regime_tag),
      notes: row.notes != null ? String(row.notes) : null,
    }))
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return []
    }
    console.warn('[strategies/db] listMarketRegimeTags failed:', errorMessage(error))
    return []
  }
}

/**
 * Derive a position's stake from the sim ledger when the caller did not pass one.
 *
 * The buys that opened the cycle are the cost basis, computed with the same helper the sims use
 * (`computeOpenSimCycle`), so the chokepoint works for every writer instead of only the ones that
 * were taught to pass a size. Best-effort: an unknown wallet or a missing cycle yields 0, and the
 * caller then logs the skip rather than inventing a stake.
 */
async function deriveStakeFromLedger(params: {
  chain: StrategyChain
  strategyId: string
  mintAddress: string
  entryAt?: string | null
  exitAt: string
}): Promise<number> {
  if (!params.mintAddress) return 0
  const { simWalletForChain, MCAP_TRACKER_SIM_WALLET } = await import('./sim-wallets')
  const { computeOpenSimCycle } = await import('@/utils/simulation-trades')
  const wallet = simWalletForChain(MCAP_TRACKER_SIM_WALLET, params.chain)
  const records = await fetchTradingRecordsForWallet(wallet, { sinceLastClose: true })
  const cycle = computeOpenSimCycle(records, params.mintAddress)
  const stake = Number(cycle?.totalSolBought)
  return Number.isFinite(stake) && stake > 0 ? stake : 0
}

/**
 * Does ANY outcome row exist for this (chain, strategy, mint)? Used by the paper closer to decide
 * whether a trade whose scoped ledger cycle is empty is genuinely closed (own sell AND an outcome),
 * or half-closed. Mint-level on purpose: the mcap strategies are one-shot per (strategy, mint)
 * (`loadMcapSimClosedOutcomeKeys`). Throws on a DB error — a failed read must not read as "none".
 */
export async function hasStrategyOutcome(params: {
  chain: StrategyChain
  strategyId: string
  tokenAddress: string
}): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM strategy_outcomes
      WHERE chain = $1 AND strategy_id = $2 AND token_address = $3
      LIMIT 1`,
    [params.chain, params.strategyId, params.tokenAddress],
  )
  return row != null
}

export async function insertStrategyOutcome(params: {
  strategy_id: string
  domain: StrategyDomain
  chain?: StrategyChain
  token_address: string
  entry_at?: string | null
  exit_at?: string | null
  pnl_pct?: number | null
  status?: string | null
  is_simulated?: boolean
  features?: Record<string, unknown> | null
  /** Entry size for the shadow execution record; omit to skip it. */
  sol_amount?: number | null
}): Promise<boolean> {
  const chain = params.chain ?? 'sol'
  const entryAt = coerceIsoTimestamp(params.entry_at)
  const exitProvided = params.exit_at != null && String(params.exit_at).trim() !== ''
  const coercedExit = coerceIsoTimestamp(params.exit_at)
  if (exitProvided && !coercedExit) {
    console.warn('[strategies/db] outcome insert skipped: unparseable exit_at')
    return false
  }
  const exitAt = coercedExit ?? new Date().toISOString()

  let features = params.features ?? {}

  if (params.token_address && entryAt && params.domain !== 'dlmm') {
    features = await enrichOutcomeFeaturesWithTracker({
      tokenAddress: params.token_address,
      entryAt,
      exitAt,
      features,
    })
  }

  const regimeTag = await loadRegimeTagForDate(exitAt.slice(0, 10))
  if (regimeTag) {
    features = { ...features, regime_tag_at_exit: regimeTag }
  }
  features = applyAutoOutcomeLabels(features, params.pnl_pct, params.status)

  // Shadow execution record: how this close would really have filled. Sims only — the live path
  // (is_simulated: false) must never wait on a quote. Omits the record when the entry size is not
  // in the features, rather than inventing one.
  // `is_simulated` DEFAULTS TO TRUE in the column (db/init/02-schema.sql:562), so a writer that
  // omits it produces a simulated row while this parameter is undefined. Requiring a truthy value
  // here silently excluded those writers from every downstream feature — the mismatch that made the
  // execution record look unwired for four rounds. Match the column: only an explicit false is live.
  if (params.is_simulated !== false && exitProvided && params.pnl_pct != null) {
    const priceRatio = 1 + Number(params.pnl_pct) / 100
    // The stake: what the caller passed, else derived from the sim ledger (the buys that opened the
    // position, the same construction the sims use). It is NOT in the features — measured over two
    // days, 763 sim closes carry an `amount_sol` key with a usable value on zero of them.
    let costSol = Number(params.sol_amount)
    if (!(Number.isFinite(costSol) && costSol > 0)) {
      costSol = await deriveStakeFromLedger({
        chain,
        strategyId: params.strategy_id,
        mintAddress: params.token_address,
        entryAt,
        exitAt,
      }).catch(() => 0)
    }
    if (Number.isFinite(costSol) && costSol > 0 && priceRatio > 0) {
      const exec = await buildShadowExecutionRecordForCost({
        chain,
        mint: params.token_address,
        costSol,
        priceRatio,
      })
      if (exec) features = { ...features, exec }
      else console.warn('[sim-exec] record not built', { strategy: params.strategy_id, costSol, priceRatio })
    } else {
      // Loud on purpose: a silent skip here is indistinguishable from "not wired", which cost three
      // debugging rounds. A close that should have a record and does not says so.
      console.warn('[sim-exec] skipped: no usable stake', {
        strategy: params.strategy_id,
        sol_amount: params.sol_amount ?? null,
        derived: costSol,
        priceRatio,
      })
    }
  }

  const { toCanonicalEntryFeatures } = await import('./canonical-features')
  const mintFromFeatures =
    typeof features.mint_address === 'string' ? features.mint_address : null
  const poolFromFeatures =
    typeof features.pool_address === 'string' ? features.pool_address : null
  features = toCanonicalEntryFeatures(features, params.domain, {
    mintAddress:
      params.domain === 'dlmm' ? mintFromFeatures : params.token_address,
    poolAddress:
      poolFromFeatures ??
      (params.domain === 'dlmm' && !mintFromFeatures ? params.token_address : null),
    entryAt,
  })

  try {
    await ensureStrategyChainColumns()
    // One row per (chain, strategy_id, token_address, entry_at): a re-close or a
    // re-mark updates the existing outcome instead of appending another. Written
    // as update-else-insert rather than ON CONFLICT so it is idempotent on its own
    // — it does not need db/init/45-strategy-outcomes-identity.sql applied first,
    // so deploy order cannot turn writes into errors. The unique index stays a
    // backstop against a concurrent race.
    const { rows: written } = await query<{ id: string; op: string }>(
      `WITH updated AS (
         UPDATE strategy_outcomes
            SET exit_at = $5, pnl_pct = $6, status = $7,
                is_simulated = $8, features = $9
          WHERE chain = $10 AND strategy_id = $1
            AND token_address = $3 AND entry_at = $4
        RETURNING id
       ), ins AS (
         INSERT INTO strategy_outcomes (
           strategy_id, domain, token_address, entry_at, exit_at,
           pnl_pct, status, is_simulated, features, chain
         )
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
          WHERE NOT EXISTS (SELECT 1 FROM updated)
        RETURNING id
       )
       SELECT id, 'inserted' AS op FROM ins
       UNION ALL
       SELECT id, 'updated'  AS op FROM updated`,
      [
        params.strategy_id,
        params.domain,
        params.token_address,
        entryAt,
        exitAt,
        params.pnl_pct ?? null,
        params.status ?? null,
        params.is_simulated ?? true,
        JSON.stringify(features),
        chain,
      ],
    )
    const outcomeId = written[0]?.id ?? null
    // Side effects describe a newly closed trade; a re-mark of the same identity
    // has already fired them.
    const isNewOutcome = written[0]?.op === 'inserted'
    if (isNewOutcome && params.token_address && outcomeId) {
      const { scheduleEpisodeFinalize } = await import('@/strategies/strategy-episodes')
      scheduleEpisodeFinalize(params.token_address, outcomeId)
      try {
        const { resolvePredictionsForClosedOutcome } = await import('./eval-engine-db')
        await resolvePredictionsForClosedOutcome({
          outcomeId,
          mint: params.token_address,
          strategyId: params.strategy_id,
          features,
          pnlPct: params.pnl_pct ?? null,
          status: params.status ?? null,
        })
      } catch (error) {
        console.warn(
          '[strategies/db] resolve ML predictions failed:',
          errorMessage(error),
        )
      }
    }
  } catch (error) {
    if (isMissingSchemaError(error)) {
      // Schema not deployed yet: nothing can be written, and this is a deploy-order condition, not
      // a transient fault. Still loud, and still `false` so a caller can tell it from success.
      console.error('[strategies/db] outcome insert skipped: strategy_outcomes schema missing', {
        strategy: params.strategy_id,
        token: params.token_address,
      })
      return false
    }
    // PROPAGATE. This used to `console.warn` and return false, and the mcap closer ignored the
    // return value, so a sell record was written with no outcome (Reggie[tp150]) and the close
    // reported success. A failed outcome write must fail the close so it is retried and seen.
    console.error('[strategies/db] outcome insert failed:', errorMessage(error), {
      strategy: params.strategy_id,
      token: params.token_address,
    })
    throw error
  }
  return true
}

export async function listStrategyOutcomes(params: {
  strategyId?: string
  domain?: StrategyDomain
  chain?: StrategyChain
  isSimulated?: boolean
  from?: string
  to?: string
  mlLabel?: string
  mlCondition?: string
  status?: string
  pnlMin?: number
  pnlMax?: number
  entryMcapBand?: string
  tokenAddress?: string
  trainingClassOnly?: boolean
  trainingClassMin?: number
  recomputeLabels?: boolean
  /** Include bookkeeping closes (`close_reason = 'orphan_reconcile'`). Default: excluded. */
  includeNonTrade?: boolean
  limit?: number
  offset?: number
}): Promise<{ rows: StrategyOutcomeRow[]; total: number }> {
  const limit = params.limit ?? 50
  const offset = params.offset ?? 0

  const { sql: whereSql, values } = buildOutcomeWhereClause(params)

  // Bound the rows pulled into Node: fetch just the page window plus a little
  // headroom for dedupe, never the whole chain. (Was: SELECT * of every match
  // then JS slice — full wide-row pulls every 15s from the map/admin polls.)
  const fetchCap = 2_000
  const fetchLimit = Math.min(Math.max(offset + limit, 1), fetchCap) + 25

  let rows: StrategyOutcomeRow[]
  let total = 0
  try {
    const [result, count] = await Promise.all([
      query<Record<string, unknown>>(
        `SELECT * FROM strategy_outcomes
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT $${values.length + 1}`,
        [...values, fetchLimit],
      ),
      query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM strategy_outcomes
         ${whereSql}`,
        values,
      ).catch(() => null),
    ])
    rows = result.rows.map(mapStrategyOutcomeRow)
    total = Number(count?.rows?.[0]?.n ?? 0)
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return { rows: [], total: 0 }
    }
    throw error
  }

  let deduped = dedupeStrategyOutcomeRows(rows)
  if (params.trainingClassOnly || params.trainingClassMin != null) {
    deduped = deduped.filter((row) =>
      matchesTrainingClassFilter(row, {
        trainingClassOnly: params.trainingClassOnly,
        trainingClassMin: params.trainingClassMin,
        recompute: params.recomputeLabels,
      }),
    )
  }
  deduped.sort((a, b) =>
    (b.created_at ?? '').localeCompare(a.created_at ?? ''),
  )
  const page = deduped.slice(offset, offset + limit)
  const enriched = await enrichOutcomeSymbols(page)
  try {
    const { attachMlPredictionsToOutcomes } = await import('./eval-engine-db')
    const withPreds = await attachMlPredictionsToOutcomes(enriched)
    return { rows: withPreds, total }
  } catch {
    return { rows: enriched, total }
  }
}

export type RecentStrategyToken = {
  address: string
  symbol: string
  source: 'outcomes' | 'mcap'
}

/** Distinct tokens last seen by strategies / mcap tracker on a chain. */
export async function listRecentStrategyTokens(
  chain: StrategyChain,
  limit = 30,
): Promise<RecentStrategyToken[]> {
  try {
    await ensureStrategyChainColumns()
    const [outcomes, mcap] = await Promise.all([
      query<{ token_address: string; symbol: string | null }>(
        `SELECT token_address, symbol FROM (
           SELECT DISTINCT ON (lower(token_address))
             token_address,
             COALESCE(NULLIF(token_symbol, ''), features->>'token_symbol') AS symbol,
             created_at
           FROM strategy_outcomes
           WHERE chain = $1
             AND token_address IS NOT NULL
             AND token_address <> ''
           ORDER BY lower(token_address), created_at DESC NULLS LAST
         ) t
         ORDER BY created_at DESC NULLS LAST
         LIMIT $2`,
        [chain, limit],
      ).catch(() => ({ rows: [] as Array<{ token_address: string; symbol: string | null }> })),
      query<{ token_address: string; token_symbol: string | null }>(
        `SELECT token_address, token_symbol
         FROM token_mcap_tracking
         WHERE chain = $1
           AND token_address IS NOT NULL
           AND token_address <> ''
         ORDER BY last_updated_at DESC NULLS LAST
         LIMIT $2`,
        [chain, limit],
      ).catch(() => ({ rows: [] as Array<{ token_address: string; token_symbol: string | null }> })),
    ])
    const out: RecentStrategyToken[] = []
    const seen = new Set<string>()
    const push = (address: string, symbol: string | null, source: RecentStrategyToken['source']) => {
      const key = address.startsWith('0x') ? address.toLowerCase() : address
      if (!key || seen.has(key)) return
      seen.add(key)
      out.push({
        address: key,
        symbol: (symbol ?? '').trim() || key.slice(0, 6),
        source,
      })
    }
    for (const row of outcomes.rows) push(row.token_address, row.symbol, 'outcomes')
    for (const row of mcap.rows) push(row.token_address, row.token_symbol, 'mcap')
    return out.slice(0, limit)
  } catch (error) {
    if (isMissingSchemaError(error)) return []
    console.warn('[strategies/db] recent tokens failed:', errorMessage(error))
    return []
  }
}

/** All closed outcomes for ML dataset stats (no pagination). */
export async function loadOutcomesForMlDataset(params?: {
  domain?: StrategyDomain
  strategyId?: string
  strategyIds?: string[]
}): Promise<StrategyOutcomeRow[]> {
  const { sql: whereSql, values } = buildOutcomeWhereClause({
    domain: params?.domain,
    strategyId: params?.strategyId,
    strategyIds: params?.strategyIds,
  })

  let rows: StrategyOutcomeRow[]
  try {
    const result = await query<Record<string, unknown>>(
      `SELECT * FROM strategy_outcomes ${whereSql}`,
      values,
    )
    rows = result.rows.map(mapStrategyOutcomeRow)
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return []
    }
    throw error
  }

  const deduped = dedupeStrategyOutcomeRows(rows)
  return enrichOutcomeSymbols(deduped)
}

/** The feature keys `applyAutoOutcomeLabels` writes — a row already matching them is skipped. */
const AUTO_LABEL_KEYS = [
  'training_class',
  'ml_label',
  'ml_condition',
  'ml_win',
  'ml_r_bucket',
  'ml_note',
] as const

/** Rows written per statement. One round trip per 500 rows instead of one per row. */
const LABEL_WRITE_CHUNK = 500

function autoLabelsEqual(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): boolean {
  for (const key of AUTO_LABEL_KEYS) {
    if (JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null)) {
      return false
    }
  }
  return true
}

/**
 * Recompute the auto ML labels.
 *
 * Rewritten for the table it actually runs on (~82k outcomes): one read, one in-memory pass that
 * keeps only rows whose labels changed, then set-based chunked writes plus one batched prediction
 * resolution per chunk. The previous version did one UPDATE and one `resolvePredictionsFor…`
 * per row, with no change check, which is why the unscoped run outlived nginx's 60 s read timeout
 * and surfaced as an HTML gateway page.
 */
export async function backfillOutcomeLabels(params?: {
  domain?: StrategyDomain
  strategyId?: string
  strategyIds?: string[]
  dryRun?: boolean
}): Promise<{
  updated: number
  unchanged: number
  skipped_manual: number
  preview: Record<'0' | '1' | '2' | '3' | '4' | 'null', number>
}> {
  const rows = await loadOutcomesForMlDataset({
    domain: params?.domain,
    strategyId: params?.strategyId,
    strategyIds: params?.strategyIds,
  })

  const preview: Record<'0' | '1' | '2' | '3' | '4' | 'null', number> = {
    '0': 0,
    '1': 0,
    '2': 0,
    '3': 0,
    '4': 0,
    null: 0,
  }
  // The preview tallies every row; only `pending` is written.
  const pending: Array<{
    id: string
    strategy_id: string
    token_address: string
    features: Record<string, unknown>
    pnl_pct: number | null
    status: string | null
  }> = []
  let skippedManual = 0
  let unchanged = 0

  for (const row of rows) {
    if (row.features?.ml_manual === true) {
      skippedManual += 1
      continue
    }

    const nextFeatures = applyAutoOutcomeLabels(row.features, row.pnl_pct, row.status)
    const tc = readTrainingClass(nextFeatures)
    if (tc === 0 || tc === 1 || tc === 2 || tc === 3 || tc === 4) {
      preview[String(tc) as '0' | '1' | '2' | '3' | '4'] += 1
    } else {
      preview.null += 1
    }

    if (params?.dryRun) continue
    if (autoLabelsEqual(row.features, nextFeatures)) {
      unchanged += 1
      continue
    }
    pending.push({
      id: row.id,
      strategy_id: row.strategy_id,
      token_address: row.token_address ?? '',
      features: nextFeatures,
      pnl_pct: row.pnl_pct,
      status: row.status,
    })
  }

  let updated = 0
  if (!params?.dryRun) {
    for (let i = 0; i < pending.length; i += LABEL_WRITE_CHUNK) {
      const chunk = pending.slice(i, i + LABEL_WRITE_CHUNK)
      try {
        await query(
          `UPDATE strategy_outcomes o
              SET features = v.features::jsonb
             FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::jsonb[]) AS features) v
            WHERE o.id = v.id`,
          [chunk.map((row) => row.id), chunk.map((row) => JSON.stringify(row.features))],
        )
        updated += chunk.length
      } catch (error) {
        console.warn(
          '[strategies/db] backfillOutcomeLabels chunk write failed:',
          errorMessage(error),
        )
      }

      const resolvable = chunk.filter((row) => row.token_address)
      if (resolvable.length > 0) {
        try {
          const { resolvePredictionsForClosedOutcomes } = await import('./eval-engine-db')
          await resolvePredictionsForClosedOutcomes(
            resolvable.map((row) => ({
              outcomeId: row.id,
              mint: row.token_address,
              strategyId: row.strategy_id,
              features: row.features,
              pnlPct: row.pnl_pct,
              status: row.status,
            })),
          )
        } catch (error) {
          console.warn(
            '[strategies/db] resolve ML predictions on backfill failed:',
            errorMessage(error),
          )
        }
      }
    }
  }

  return { updated, unchanged, skipped_manual: skippedManual, preview }
}

async function enrichOutcomeSymbols(
  rows: StrategyOutcomeRow[],
): Promise<StrategyOutcomeRow[]> {
  const needLookup = rows.filter(
    (r) => !readTokenSymbol(r.features) && r.token_address,
  )
  if (needLookup.length === 0) return rows

  const addresses = Array.from(new Set(needLookup.map((r) => r.token_address!)))
  const trackerTable = getTrackerTableName()

  const [trackerRows, signalsRows, mcapRows] = await Promise.all([
    query<{ token_address: string; token_symbol: string | null }>(
      `SELECT token_address, token_symbol FROM ${trackerTable}
       WHERE token_address = ANY($1::text[])`,
      [addresses],
    ).then((r) => r.rows).catch(() => [] as Array<{ token_address: string; token_symbol: string | null }>),
    query<{ token_address: string; token_symbol: string | null }>(
      `SELECT token_address, token_symbol FROM trading_signals
       WHERE token_address = ANY($1::text[])`,
      [addresses],
    ).then((r) => r.rows).catch(() => [] as Array<{ token_address: string; token_symbol: string | null }>),
    query<{ token_address: string; token_symbol: string | null }>(
      `SELECT token_address, token_symbol FROM token_mcap_tracking
       WHERE token_address = ANY($1::text[])`,
      [addresses],
    ).then((r) => r.rows).catch(() => [] as Array<{ token_address: string; token_symbol: string | null }>),
  ])

  const symbolMap = new Map<string, string>()
  for (const row of trackerRows) {
    if (row.token_symbol) symbolMap.set(row.token_address, row.token_symbol)
  }
  for (const row of signalsRows) {
    if (row.token_symbol && !symbolMap.has(row.token_address)) {
      symbolMap.set(row.token_address, row.token_symbol)
    }
  }
  for (const row of mcapRows) {
    if (row.token_symbol && !symbolMap.has(row.token_address)) {
      symbolMap.set(row.token_address, row.token_symbol)
    }
  }

  return rows.map((r) => {
    if (readTokenSymbol(r.features) || !r.token_address) return r
    const sym = symbolMap.get(r.token_address)
    if (!sym) return r
    return {
      ...r,
      features: { ...(r.features ?? {}), token_symbol: sym },
    }
  })
}

export async function loadStrategyOutcomeById(
  id: string,
): Promise<StrategyOutcomeRow | null> {
  try {
    const row = await queryOne<Record<string, unknown>>(
      `SELECT * FROM strategy_outcomes WHERE id = $1 LIMIT 1`,
      [id],
    )
    return row ? mapStrategyOutcomeRow(row) : null
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return null
    }
    throw error
  }
}

export async function updateStrategyOutcomeFeatures(
  id: string,
  featurePatch: Record<string, unknown>,
): Promise<{ ok: boolean; row?: StrategyOutcomeRow; error?: string }> {
  const existing = await loadStrategyOutcomeById(id)
  if (!existing) {
    return { ok: false, error: 'Outcome not found' }
  }

  const mergedFeatures = {
    ...(existing.features ?? {}),
    ...featurePatch,
  }

  try {
    const row = await queryOne<Record<string, unknown>>(
      `UPDATE strategy_outcomes SET features = $2 WHERE id = $1 RETURNING *`,
      [id, JSON.stringify(mergedFeatures)],
    )
    if (!row) {
      return { ok: false, error: 'Outcome not found' }
    }
    return { ok: true, row: mapStrategyOutcomeRow(row) }
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return { ok: false, error: 'Outcomes table unavailable' }
    }
    return { ok: false, error: errorMessage(error) }
  }
}

export type OutcomeTradeWindowChartResult = {
  points: OutcomeChartPoint[]
  source: OutcomeChartSource
  volume_point_count: number
  has_volume: boolean
}

async function enrichOutcomeFeaturesWithTracker(params: {
  tokenAddress: string
  entryAt: string
  exitAt: string
  features: Record<string, unknown>
}): Promise<Record<string, unknown>> {
  const metrics = await fetchTrackerTokenMetrics(params.tokenAddress)
  if (!metrics?.price_history) {
    if (
      params.features.volume_at_entry == null &&
      typeof metrics?.volume_5m === 'number'
    ) {
      return {
        ...params.features,
        volume_at_entry: metrics.volume_5m,
        volume_5m: metrics.volume_5m,
      }
    }
    return params.features
  }

  const historyPoints = filterPointsToWindow(
    parsePriceHistory(metrics.price_history),
    params.entryAt,
    params.exitAt,
  )
  if (historyPoints.length < 2) {
    if (
      params.features.volume_at_entry == null &&
      typeof metrics.volume_5m === 'number'
    ) {
      return {
        ...params.features,
        volume_at_entry: metrics.volume_5m,
        volume_5m: metrics.volume_5m,
      }
    }
    return params.features
  }

  const snapshots = priceHistoryToMonitorSnapshots(
    historyPoints,
    params.entryAt,
    params.exitAt,
  )
  return enrichFeaturesWithMonitorSnapshots(params.features, snapshots)
}

function buildSyntheticChartPoints(params: {
  entryAt: string
  exitAt: string
  features: Record<string, unknown>
}): { points: OutcomeChartPoint[]; source: OutcomeChartSource } | null {
  const { entryAt, exitAt, features } = params
  const initialPrice = features.initial_price_usd
  const exitPrice = features.exit_price_usd
  const entryMcap =
    typeof features.entry_mcap === 'number' && Number.isFinite(features.entry_mcap)
      ? features.entry_mcap
      : null
  const exitMcap =
    typeof features.exit_mcap === 'number' && Number.isFinite(features.exit_mcap)
      ? features.exit_mcap
      : null

  const entryVolume = readVolumeFromFeatures(features)
  const exitVolume = lastSnapshotVolume(features) ?? entryVolume

  if (
    typeof initialPrice === 'number' &&
    typeof exitPrice === 'number' &&
    !Number.isNaN(initialPrice) &&
    !Number.isNaN(exitPrice)
  ) {
    return {
      points: [
        { timestamp: entryAt, price_usd: initialPrice, volume_5m: entryVolume },
        { timestamp: exitAt, price_usd: exitPrice, volume_5m: exitVolume },
      ],
      source: 'outcome_features',
    }
  }

  if (
    entryMcap != null &&
    entryMcap > 0 &&
    exitMcap != null &&
    typeof initialPrice === 'number' &&
    !Number.isNaN(initialPrice)
  ) {
    const derivedExit = initialPrice * (exitMcap / entryMcap)
    return {
      points: [
        { timestamp: entryAt, price_usd: initialPrice, volume_5m: entryVolume },
        { timestamp: exitAt, price_usd: derivedExit, volume_5m: exitVolume },
      ],
      source: 'outcome_features',
    }
  }

  if (typeof exitPrice === 'number' && !Number.isNaN(exitPrice)) {
    return {
      points: [
        { timestamp: entryAt, price_usd: exitPrice, volume_5m: entryVolume },
        { timestamp: exitAt, price_usd: exitPrice, volume_5m: exitVolume },
      ],
      source: 'synthetic',
    }
  }

  return null
}

export async function loadOutcomeTradeWindowChart(params: {
  outcome: StrategyOutcomeRow
}): Promise<OutcomeTradeWindowChartResult> {
  const { outcome } = params
  const entryAt = outcome.entry_at
  const exitAt = outcome.exit_at
  const tokenAddress = outcome.token_address
  const domain = outcome.domain
  const features = outcome.features ?? {}

  if (!entryAt || !exitAt) {
    return { points: [], source: 'empty', volume_point_count: 0, has_volume: false }
  }

  const monitorSnapshots = readMonitorSnapshotsFromFeatures(features)
  const initialPrice = features.initial_price_usd
  const exitPrice = features.exit_price_usd
  const entryMcap =
    typeof features.entry_mcap === 'number' && Number.isFinite(features.entry_mcap)
      ? features.entry_mcap
      : null

  let trackerPoints: OutcomeChartPoint[] = []
  if (tokenAddress && !shouldSkipTrackerForDomain(domain)) {
    const metrics = await fetchTrackerTokenMetrics(tokenAddress)
    if (metrics?.price_history) {
      trackerPoints = filterPointsToWindow(
        parsePriceHistory(metrics.price_history),
        entryAt,
        exitAt,
      )
    }
  }

  const monitorPoints = monitorSnapshotsToChartPoints(
    monitorSnapshots,
    entryAt,
    exitAt,
    {
      initialPriceUsd:
        typeof initialPrice === 'number' && !Number.isNaN(initialPrice)
          ? initialPrice
          : null,
      entryMcap,
    },
  )

  const preferTracker =
    shouldUseTrackerHistoryFirst(domain) ||
    (domain === 'mcap_tracker' &&
      trackerPoints.length >= 2 &&
      trackerHistoryHasVolume(trackerPoints))

  if (preferTracker && trackerPoints.length > 0) {
    const points = mergeVolumeFromMonitorSnapshots(trackerPoints, monitorSnapshots)
    return {
      points,
      source: 'tracker',
      volume_point_count: countVolumePoints(points),
      has_volume: hasVolumeOnPoints(points),
    }
  }

  if (monitorPoints.length >= 2) {
    return {
      points: monitorPoints,
      source: 'outcome_features',
      volume_point_count: countVolumePoints(monitorPoints),
      has_volume: hasVolumeOnPoints(monitorPoints),
    }
  }

  if (trackerPoints.length >= 2) {
    const points = mergeVolumeFromMonitorSnapshots(trackerPoints, monitorSnapshots)
    return {
      points,
      source: 'tracker',
      volume_point_count: countVolumePoints(points),
      has_volume: hasVolumeOnPoints(points),
    }
  }

  const synthetic = buildSyntheticChartPoints({ entryAt, exitAt, features })
  if (synthetic) {
    const points = mergeVolumeFromMonitorSnapshots(synthetic.points, monitorSnapshots)
    return {
      points,
      source: synthetic.source,
      volume_point_count: countVolumePoints(points),
      has_volume: hasVolumeOnPoints(points),
    }
  }

  if (monitorPoints.length === 1) {
    return {
      points: monitorPoints,
      source: 'outcome_features',
      volume_point_count: countVolumePoints(monitorPoints),
      has_volume: hasVolumeOnPoints(monitorPoints),
    }
  }

  return { points: [], source: 'empty', volume_point_count: 0, has_volume: false }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function computeMlLabelStats(rows: StrategyOutcomeRow[]): MlLabelStats {
  const stats: MlLabelStats = {
    total: rows.length,
    unlabeled: 0,
    by_label: {},
    by_condition: {},
  }
  for (const row of rows) {
    const label = row.features?.ml_label
    if (typeof label === 'string' && label.trim()) {
      stats.by_label[label] = (stats.by_label[label] ?? 0) + 1
    } else {
      stats.unlabeled++
    }
    const condition = row.features?.ml_condition
    if (typeof condition === 'string' && condition.trim()) {
      stats.by_condition[condition] = (stats.by_condition[condition] ?? 0) + 1
    }
  }
  return stats
}

function bucketMcapOutcomeStats(
  rows: StrategyOutcomeRow[],
): Pick<McapTrackerMilestoneBucket, 'trade_count' | 'win_count' | 'win_rate' | 'avg_pnl_pct'> {
  const pnls = rows
    .map((r) => (r.pnl_pct != null ? Number(r.pnl_pct) : null))
    .filter((v): v is number => v != null && Number.isFinite(v))
  const summary = summarizeClosedPnls(pnls)
  return {
    trade_count: rows.length,
    win_count: summary.winCount,
    win_rate: rows.length ? summary.winCount / rows.length : 0,
    avg_pnl_pct: pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0,
  }
}

type SimWalletRecords = import('@/utils/trading-tracker').TrackingRecord[]

const MCAP_SIM_RECORDS_TTL_MS = 60_000
let mcapSimRecordsCache: { at: number; records: SimWalletRecords } | null = null

/**
 * The sim wallet's history, bounded to what the reconstruction needs and reused for up to
 * 60 s. One report needs it twice (open positions and coverage counts) and the full history
 * is ~27 MB; the values are display-only and the sim's own cycle is slower than this TTL.
 *
 * The bound is `sinceLastClose`, which is exact because it is keyed per (strategy, mint) —
 * see fetchTradingRecordsForWallet. It returns 2,095 records where the whole history is
 * 5,283. Guarded by a unit test that the query keeps the strategy key.
 */
export async function loadMcapSimRecords(): Promise<SimWalletRecords> {
  const now = Date.now()
  if (mcapSimRecordsCache && now - mcapSimRecordsCache.at < MCAP_SIM_RECORDS_TTL_MS) {
    return mcapSimRecordsCache.records
  }
  const wallet = process.env.MCAP_TRACKER_SIM_WALLET_ADDRESS || 'mcap-tracker-sim'
  const records = await fetchTradingRecordsForWallet(wallet, { sinceLastClose: true })
  mcapSimRecordsCache = { at: now, records }
  return records
}

export async function buildOpenMcapSimReportPositions(
  recordsIn?: SimWalletRecords,
): Promise<McapOpenSimReportRow[]> {
  const [defRows, records] = await Promise.all([
    loadStrategyDefinitionRows('mcap_tracker'),
    recordsIn ?? loadMcapSimRecords(),
  ])

  const positions: McapOpenSimReportRow[] = []
  const mints = new Set<string>()

  for (const def of defRows) {
    if (def.domain !== 'mcap_tracker') continue
    for (const pos of getOpenMcapSimPositions(records, def.id)) {
      mints.add(pos.mintAddress)
      positions.push({
        strategy_id: def.id,
        token_address: pos.mintAddress,
        token_symbol: pos.symbol,
        entry_mcap: pos.entryMcap,
        entry_at: pos.entryAt,
        current_mcap: null,
        unrealized_pnl_pct: null,
      })
    }
  }

  if (positions.length === 0) return positions

  const currentByMint = new Map<string, number>()
  try {
    const { rows: trackingRows } = await query<{
      token_address: string
      current_mcap: number
    }>(
      `SELECT token_address, current_mcap FROM token_mcap_tracking
       WHERE token_address = ANY($1::text[])`,
      [Array.from(mints)],
    )
    for (const row of trackingRows) {
      currentByMint.set(row.token_address, Number(row.current_mcap))
    }
  } catch (error) {
    if (!isMissingSchemaError(error)) {
      console.warn(
        '[strategies/db] open mcap sim current_mcap lookup failed:',
        errorMessage(error),
      )
    }
  }

  for (const pos of positions) {
    const current = currentByMint.get(pos.token_address)
    if (current != null && Number.isFinite(current)) {
      pos.current_mcap = current
      pos.unrealized_pnl_pct = computeMcapSimPnlPct(pos.entry_mcap, current)
    }
  }

  return positions.sort((a, b) =>
    (b.entry_at ?? '').localeCompare(a.entry_at ?? ''),
  )
}

export async function buildMcapTrackerReportStats(
  rows: StrategyOutcomeRow[],
  breakdown: StrategyReportBreakdown[],
  simRecords?: SimWalletRecords,
  openPositionsIn?: McapOpenSimReportRow[],
): Promise<McapTrackerReportStats> {
  const mcapRows = rows.filter((r) => r.domain === 'mcap_tracker' && r.is_simulated)
  const health = await getTrackingHealthStats()

  const strategies = breakdown.filter(
    (b) => b.domain === 'mcap_tracker' && b.is_simulated && b.trade_count > 0,
  )

  const milestone_buckets: McapTrackerMilestoneBucket[] = [
    {
      bucket: 'all',
      label: 'All closed sim trades',
      ...bucketMcapOutcomeStats(mcapRows),
    },
    {
      bucket: 'reached_80',
      label: 'Reached 80%',
      ...bucketMcapOutcomeStats(
        mcapRows.filter((r) => r.features?.reached_80 === true),
      ),
    },
    {
      bucket: 'reached_120',
      label: 'Reached 120%',
      ...bucketMcapOutcomeStats(
        mcapRows.filter((r) => r.features?.reached_120 === true),
      ),
    },
    {
      bucket: 'reached_200',
      label: 'Reached 200%',
      ...bucketMcapOutcomeStats(
        mcapRows.filter((r) => r.features?.reached_200 === true),
      ),
    },
  ]

  return {
    strategies,
    milestone_buckets,
    timeline_inconsistent_count: health.timelineInconsistentCount,
    total_tracked_tokens: health.totalTokens,
    open_sim_positions: openPositionsIn ?? (await buildOpenMcapSimReportPositions(simRecords)),
  }
}

export type StrategyPnlLeaderboardSection = {
  domain: StrategyDomain
  strategy_id: string
  name: string
  trades: StrategyOutcomeRow[]
}

/** Pure rank: active defs → top `limit` closed trades by pnl_pct (SIM+LIVE mixed). */
export function rankTopPnlByActiveStrategy(
  activeDefs: StrategyDefinitionRow[],
  outcomes: StrategyOutcomeRow[],
  limit = 8,
): StrategyPnlLeaderboardSection[] {
  const active = activeDefs
    .filter((d) => d.is_active)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))

  const byStrategy = new Map<string, StrategyOutcomeRow[]>()
  for (const row of outcomes) {
    if (row.pnl_pct == null || !Number.isFinite(Number(row.pnl_pct))) continue
    const list = byStrategy.get(row.strategy_id) ?? []
    list.push(row)
    byStrategy.set(row.strategy_id, list)
  }

  const sections: StrategyPnlLeaderboardSection[] = []
  for (const def of active) {
    const list = byStrategy.get(def.id)
    if (!list?.length) continue
    const trades = [...list]
      .sort((a, b) => Number(b.pnl_pct) - Number(a.pnl_pct))
      .slice(0, limit)
    sections.push({
      domain: def.domain,
      strategy_id: def.id,
      name: def.name,
      trades,
    })
  }
  return sections
}

/** Closed realized PnL leaderboard: top N per active strategy_definitions row. */
export async function listTopPnlByActiveStrategy(
  limit = 8,
  options?: { sinceIso?: string },
): Promise<StrategyPnlLeaderboardSection[]> {
  const defs = await loadStrategyDefinitionRows()
  const active = defs.filter((d) => d.is_active)
  if (active.length === 0) return []

  const ids = active.map((d) => d.id)
  const sinceIso = options?.sinceIso?.trim() || null
  let rows: StrategyOutcomeRow[]
  try {
    const result = await query<Record<string, unknown>>(
      sinceIso
        ? `SELECT * FROM strategy_outcomes
           WHERE strategy_id = ANY($1::text[])
             AND pnl_pct IS NOT NULL
             AND COALESCE(exit_at, created_at) >= $2::timestamptz`
        : `SELECT * FROM strategy_outcomes
           WHERE strategy_id = ANY($1::text[])
             AND pnl_pct IS NOT NULL`,
      sinceIso ? [ids, sinceIso] : [ids],
    )
    rows = dedupeStrategyOutcomeRows(result.rows.map(mapStrategyOutcomeRow))
  } catch (error) {
    if (isMissingSchemaError(error)) return []
    throw error
  }

  const sections = rankTopPnlByActiveStrategy(active, rows, limit)
  const flat = sections.flatMap((s) => s.trades)
  const enriched = await enrichOutcomeSymbols(flat)
  const byId = new Map(enriched.map((r) => [r.id, r]))
  return sections.map((s) => ({
    ...s,
    trades: s.trades.map((t) => byId.get(t.id) ?? t),
  }))
}

/**
 * strategy_id -> family (independent bet). Definitions are a few dozen rows, so this
 * is fetched whole rather than resolved per id; ids with no definition row fall back
 * to themselves via the LEFT JOIN in the callers.
 */
const FAMILY_MAP_TTL_MS = 60_000
let familyMapCache: { at: number; map: Map<string, string> } | null = null

async function loadStrategyFamilyMap(): Promise<Map<string, string>> {
  const now = Date.now()
  if (familyMapCache && now - familyMapCache.at < FAMILY_MAP_TTL_MS) {
    return familyMapCache.map
  }
  const map = new Map<string, string>()
  let loaded = false
  try {
    const { rows } = await query<{ id: string; domain: string; config: unknown }>(
      `SELECT id, domain, config FROM strategy_definitions`,
    )
    for (const row of rows) {
      map.set(
        row.id,
        resolveStrategyFamily({
          strategyId: row.id,
          domain: row.domain as StrategyDomain,
          config: (row.config ?? {}) as Record<string, unknown>,
        }),
      )
    }
    loaded = true
  } catch (error) {
    if (!isMissingSchemaError(error)) {
      console.warn('[strategies/db] strategy family map failed:', errorMessage(error))
    }
  }
  // Only cache a real read: a missing-schema failure must be retried, not pinned.
  if (loaded) familyMapCache = { at: now, map }
  return map
}

/**
 * Tokens entered by more than one strategy within the report filters.
 *
 * Reports both the raw count and the count of independent FAMILIES, because the
 * search spawner fills its slots with grid neighbours (same entry rule, different
 * take profit) — measured Jaccard 0.37-0.66 among them. `strategy_count` is kept so
 * the clone inflation is visible rather than hidden: "5 rows, 2 bets".
 *
 * Windowed equivalent of db/init/46-token-strategy-overlap-view.sql, which stays a
 * whole-table raw count (a view cannot resolve families).
 */
export async function loadTokenStrategyOverlap(
  params: OutcomeFilterParams & { limit?: number },
): Promise<StrategyOverlapRow[]> {
  const limit = params.limit ?? 50
  const { sql: whereSql, values } = buildOutcomeWhereClause(params)
  const where = whereSql ? `${whereSql} AND` : 'WHERE'
  const limitIdx = values.length + 1

  try {
    const familyMap = await loadStrategyFamilyMap()
    const famIds = [...familyMap.keys()]
    const famVals = famIds.map((id) => familyMap.get(id)!)
    const idsIdx = limitIdx + 1
    const valsIdx = idsIdx + 1

    const { rows } = await query<{
      chain: string
      token_address: string
      strategy_count: number
      strategies: string[]
      family_count: number
      families: string[]
      trades: number
      wins: number
      losses: number
      median_pnl_pct: string | number | null
      first_entry: string | null
      last_exit: string | null
    }>(
      `SELECT o.chain,
              o.token_address,
              count(DISTINCT o.strategy_id)::int AS strategy_count,
              array_agg(DISTINCT o.strategy_id) AS strategies,
              count(DISTINCT coalesce(fam.family, o.strategy_id))::int AS family_count,
              array_agg(DISTINCT coalesce(fam.family, o.strategy_id)) AS families,
              count(*)::int AS trades,
              count(*) FILTER (WHERE o.pnl_pct > 1e-6)::int AS wins,
              count(*) FILTER (WHERE o.pnl_pct < -1e-6)::int AS losses,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY o.pnl_pct) AS median_pnl_pct,
              min(o.entry_at) AS first_entry,
              max(o.exit_at) AS last_exit
         FROM strategy_outcomes o
         LEFT JOIN unnest($${idsIdx}::text[], $${valsIdx}::text[]) AS fam(strategy_id, family)
                ON fam.strategy_id = o.strategy_id
         ${where} o.token_address IS NOT NULL
        GROUP BY o.chain, o.token_address
       HAVING count(DISTINCT o.strategy_id) > 1
        ORDER BY strategy_count DESC, trades DESC
        LIMIT $${limitIdx}`,
      [...values, limit, famIds, famVals],
    )
    return rows.map((row) => ({
      chain: row.chain,
      token_address: row.token_address,
      strategy_count: Number(row.strategy_count),
      strategies: row.strategies ?? [],
      family_count: Number(row.family_count),
      families: row.families ?? [],
      trades: Number(row.trades),
      wins: Number(row.wins),
      losses: Number(row.losses),
      median_pnl_pct:
        row.median_pnl_pct == null ? null : Number(row.median_pnl_pct),
      first_entry: coerceIsoTimestamp(row.first_entry),
      last_exit: coerceIsoTimestamp(row.last_exit),
    }))
  } catch (error) {
    if (isMissingSchemaError(error)) return []
    console.warn('[strategies/db] token strategy overlap failed:', errorMessage(error))
    return []
  }
}

/**
 * Pairwise token-set overlap (Jaccard) between strategies over the report filters.
 *
 * Separates the two things a high number can mean: `same_family` pairs are the
 * spawner's redundant clones (a defect), different-family pairs are genuine
 * agreement — the only ones worth testing as a signal.
 */
export async function loadStrategyPairOverlap(
  params: OutcomeFilterParams & { limit?: number },
): Promise<StrategyPairOverlapRow[]> {
  const limit = params.limit ?? 25
  const { sql: whereSql, values } = buildOutcomeWhereClause(params)
  const where = whereSql ? `${whereSql} AND` : 'WHERE'
  const limitIdx = values.length + 1

  try {
    const { rows } = await query<{
      strategy_a: string
      strategy_b: string
      shared: number
      a_tokens: number
      b_tokens: number
      jaccard: string | number
    }>(
      `WITH s AS (
         SELECT DISTINCT chain, token_address, strategy_id
           FROM strategy_outcomes
           ${where} token_address IS NOT NULL
       ), sz AS (
         SELECT strategy_id, count(*)::int AS n FROM s GROUP BY 1
       )
       SELECT a.strategy_id AS strategy_a,
              b.strategy_id AS strategy_b,
              count(*)::int AS shared,
              sa.n AS a_tokens,
              sb.n AS b_tokens,
              count(*)::numeric / (sa.n + sb.n - count(*)) AS jaccard
         FROM s a
         JOIN s b ON a.token_address = b.token_address
                 AND a.chain = b.chain
                 AND a.strategy_id < b.strategy_id
         JOIN sz sa ON sa.strategy_id = a.strategy_id
         JOIN sz sb ON sb.strategy_id = b.strategy_id
        GROUP BY 1, 2, sa.n, sb.n
       HAVING count(*) >= 2
        ORDER BY jaccard DESC, shared DESC
        LIMIT $${limitIdx}`,
      [...values, limit],
    )
    const familyMap = await loadStrategyFamilyMap()
    return rows.map((row) => {
      const famA = familyMap.get(row.strategy_a) ?? row.strategy_a
      const famB = familyMap.get(row.strategy_b) ?? row.strategy_b
      return {
        strategy_a: row.strategy_a,
        strategy_b: row.strategy_b,
        shared: Number(row.shared),
        a_tokens: Number(row.a_tokens),
        b_tokens: Number(row.b_tokens),
        jaccard: Number(row.jaccard),
        family_a: famA,
        family_b: famB,
        same_family: famA === famB,
      }
    })
  } catch (error) {
    if (isMissingSchemaError(error)) return []
    console.warn('[strategies/db] strategy pair overlap failed:', errorMessage(error))
    return []
  }
}

/**
 * Does strategy agreement predict the outcome? Breadth is counted in independent
 * families and the result carries confidence intervals plus an explicit
 * `inconclusive` state — see src/strategies/consensus-test.ts for the choices.
 */
export async function loadConsensusTest(
  params: OutcomeFilterParams & { limit?: number; samples?: number },
): Promise<ConsensusTestResult> {
  const limit = params.limit ?? 5000
  const { sql: whereSql, values } = buildOutcomeWhereClause(params)
  const where = whereSql ? `${whereSql} AND` : 'WHERE'
  const limitIdx = values.length + 1

  try {
    const { rows } = await query<{
      token_address: string
      strategies: string[]
      pnls: (number | string)[]
    }>(
      `SELECT token_address,
              array_agg(DISTINCT strategy_id) AS strategies,
              array_agg(pnl_pct) FILTER (WHERE pnl_pct IS NOT NULL) AS pnls
         FROM strategy_outcomes
         ${where} token_address IS NOT NULL
        GROUP BY token_address
        LIMIT $${limitIdx}`,
      [...values, limit],
    )
    const familyMap = await loadStrategyFamilyMap()
    return runConsensusTest(
      rows.map((row) => ({
        families: (row.strategies ?? []).map((id) => familyMap.get(id) ?? id),
        pnls: (row.pnls ?? [])
          .map((p) => Number(p))
          .filter((p) => Number.isFinite(p)),
      })),
      params.samples == null ? {} : { samples: params.samples },
    )
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return runConsensusTest([])
    }
    console.warn('[strategies/db] consensus test failed:', errorMessage(error))
    return runConsensusTest([])
  }
}

const CONSENSUS_EVIDENCE_TTL_MS = 10 * 60 * 1000
/** Conservative while cold/stale: not significant → no_evidence → the gate is inert. */
const CONSENSUS_EVIDENCE_COLD = {
  significant: false,
  reason: 'evidence not computed yet',
}
const consensusEvidenceCache = new Map<
  string,
  { at: number; value: { significant: boolean; reason: string }; refreshing: boolean }
>()

/**
 * Evidence for the (shadow) consensus gate.
 *
 * Never computes on the caller's path: the bootstrap is heavy (30 days of outcomes plus
 * 10k resamples), so a cold or stale entry returns the conservative "not significant" —
 * which makes the gate inert, exactly as it is today — and refreshes in the background.
 * That keeps a heavy query out of the mcap sim open request.
 */
export async function loadConsensusEvidence(
  chain: StrategyChain,
  minFamilies: number,
): Promise<{ significant: boolean; reason: string }> {
  const key = `${chain}:${minFamilies}`
  const now = Date.now()
  const hit = consensusEvidenceCache.get(key)
  if (hit && now - hit.at <= CONSENSUS_EVIDENCE_TTL_MS) return hit.value

  if (!hit?.refreshing) {
    consensusEvidenceCache.set(key, {
      at: hit?.at ?? 0,
      value: hit?.value ?? CONSENSUS_EVIDENCE_COLD,
      refreshing: true,
    })
    void (async () => {
      try {
        const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
        const result = await loadConsensusTest({ chain, from })
        const lift =
          result.lifts.find((l) => l.bucket_family_count === minFamilies) ??
          result.lifts.find((l) => l.vs === '1')
        const value = lift
          ? {
              significant: lift.significant,
              reason: `${lift.bucket_label} families vs 1: ${lift.reason}`,
            }
          : CONSENSUS_EVIDENCE_COLD
        consensusEvidenceCache.set(key, { at: Date.now(), value, refreshing: false })
      } catch (error) {
        console.warn(
          '[strategies/db] consensus evidence refresh failed:',
          errorMessage(error),
        )
        consensusEvidenceCache.set(key, {
          at: hit?.at ?? 0,
          value: hit?.value ?? CONSENSUS_EVIDENCE_COLD,
          refreshing: false,
        })
      }
    })()
  }

  return hit?.value ?? CONSENSUS_EVIDENCE_COLD
}

/**
 * What the consensus gate would decide for a would-be open: the families that have
 * already entered this mint, plus the (memoized) evidence. Returns the row to record
 * and whether the caller must actually skip the open. Gated — see consensus-gate.ts.
 */
export async function evaluateConsensusGateForOpen(params: {
  chain: StrategyChain
  strategyId: string
  tokenAddress: string
  symbol?: string | null
}): Promise<{ decision: ConsensusGateDecision; row: ConsensusShadowRow }> {
  const mode = consensusGateMode()
  const minFamilies = getConsensusMinFamilies()
  const familyMap = await loadStrategyFamilyMap()
  const { rows } = await query<{ strategy_id: string }>(
    `SELECT DISTINCT strategy_id FROM strategy_outcomes
      WHERE chain = $1 AND token_address = $2`,
    [params.chain, params.tokenAddress],
  )
  const strategies = rows.map((r) => r.strategy_id)
  const families = [...new Set(strategies.map((id) => familyMap.get(id) ?? id))]
  const evidence = await loadConsensusEvidence(params.chain, minFamilies)
  const decision = decideConsensusGate({
    familyCount: families.length,
    minFamilies,
    evidence,
    mode,
  })
  return {
    decision,
    row: {
      chain: params.chain,
      strategyId: params.strategyId,
      tokenAddress: params.tokenAddress,
      symbol: params.symbol ?? null,
      familyCount: families.length,
      families,
      strategies,
      minFamilies,
      decision: decision.decision,
      reason: decision.reason,
      evidenceSignificant: evidence.significant,
      evidenceReason: evidence.reason,
      mode,
    },
  }
}

/**
 * Token-level PnL for an inclusive day range, for the spreadsheet export.
 *
 * `from`/`to` are YYYY-MM-DD in `timeZone`, and the window is built in SQL
 * (`date::timestamp AT TIME ZONE tz`) rather than in JS — comparing a pg timestamptz against a
 * locally-formatted string is how a time filter silently matches nothing.
 *
 * `chain` is intentionally optional: passing 'sol' (which `parseStrategyChain` coerces every
 * unknown value to) drops the whole Robinhood twin — measured 261 of the 627 sim rows over
 * three days — so "all chains" has to be reachable.
 */
/**
 * Daily paper PnL: one row per calendar day the positions CLOSED (that is when the PnL is realized),
 * plus the peak simultaneously-open count per day for the capital/budget view.
 *
 * The window is built in SQL from `date::timestamp AT TIME ZONE tz` for the same reason as the export:
 * comparing a pg timestamptz against a locally-formatted string silently matches nothing.
 */
export async function aggregateDailyPnl(params: {
  from: string
  to: string
  timeZone: string
  /** Strategy ids to leave out of every aggregate — the dashboard's fold toggle. */
  excludeStrategies?: string[]
}): Promise<{
  daily: Array<{
    day: string
    trades: number
    won: number
    lost: number
    sum_pnl_pct: string | null
    sum_pnl_pct_weighted: string | null
    gross_win_pct: string | null
    gross_loss_pct: string | null
    avg_win_pct: string | null
    avg_loss_pct: string | null
    best_pnl_pct: string | null
    worst_pnl_pct: string | null
    mean_size_mult: string | null
    median_size_mult: string | null
    min_size_mult: string | null
    max_size_mult: string | null
    with_size_mult: number
    avg_pnl_pct: string | null
    median_pnl_pct: string | null
    with_exec: number
    exec_pnl_quote: string | null
  }>
  peaks: Array<{ day: string; peak_open: number }>
  bySizeMult: Array<{
    size_mult: string | null
    trades: number
    won: number
    lost: number
    sum_pnl_pct: string | null
  }>
  /** Grouped by the regime tag stamped at exit — populated once market_regime_tags has rows. */
  byRegimeTag: Array<{
    regime: string | null
    trades: number
    won: number
    lost: number
    sum_pnl_pct: string | null
  }>
  /** day -> regime tag, from market_regime_tags. Empty while tagging is dormant. */
  regimeByDay: Array<{ day: string; regime_tag: string | null }>
}> {
  const timeZone = resolveReportTimeZone(params.timeZone)
  // An empty list excludes nothing, so every query below can carry the clause unconditionally:
  // `x <> ALL('{}')` is true for every row. The coalesce matters — a bare `<> ALL` against a null
  // strategy_id yields null, which would filter those rows out even when nothing is being folded.
  const args = [params.from, params.to, timeZone, params.excludeStrategies ?? []]

  const { rows: daily } = await query<{
    day: string
    trades: number
    won: number
    lost: number
    sum_pnl_pct: string | null
    sum_pnl_pct_weighted: string | null
    gross_win_pct: string | null
    gross_loss_pct: string | null
    avg_win_pct: string | null
    avg_loss_pct: string | null
    best_pnl_pct: string | null
    worst_pnl_pct: string | null
    mean_size_mult: string | null
    median_size_mult: string | null
    min_size_mult: string | null
    max_size_mult: string | null
    with_size_mult: number
    avg_pnl_pct: string | null
    median_pnl_pct: string | null
    with_exec: number
    exec_pnl_quote: string | null
  }>(
    `SELECT to_char(date_trunc('day', exit_at AT TIME ZONE $3), 'YYYY-MM-DD') AS day,
            count(*)::int AS trades,
            count(*) FILTER (WHERE status = 'won')::int AS won,
            count(*) FILTER (WHERE status = 'lost')::int AS lost,
            sum(pnl_pct) AS sum_pnl_pct,
            -- Weighted by the size multiplier the system actually applied, so PnL in SOL reflects
            -- the real sizing instead of an assumed flat stake. coalesce(1) leaves un-stamped rows.
            sum(pnl_pct * coalesce((features->>'ml_size_mult')::numeric, 1)) AS sum_pnl_pct_weighted,
            -- Risk/reward, realized: what the winners and losers actually did.
            sum(pnl_pct) FILTER (WHERE pnl_pct > 0) AS gross_win_pct,
            sum(pnl_pct) FILTER (WHERE pnl_pct < 0) AS gross_loss_pct,
            avg(pnl_pct) FILTER (WHERE pnl_pct > 0) AS avg_win_pct,
            avg(pnl_pct) FILTER (WHERE pnl_pct < 0) AS avg_loss_pct,
            max(pnl_pct) AS best_pnl_pct,
            min(pnl_pct) AS worst_pnl_pct,
            -- Mean applied sizing, so the average stake at risk is base stake x this.
            avg(coalesce((features->>'ml_size_mult')::numeric, 1)) AS mean_size_mult,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY (features->>'ml_size_mult')::numeric) AS median_size_mult,
            min((features->>'ml_size_mult')::numeric) AS min_size_mult,
            max((features->>'ml_size_mult')::numeric) AS max_size_mult,
            count(*) FILTER (WHERE features ? 'ml_size_mult')::int AS with_size_mult,
            avg(pnl_pct) AS avg_pnl_pct,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY pnl_pct) AS median_pnl_pct,
            count(*) FILTER (WHERE features ? 'exec')::int AS with_exec,
            sum((features->'exec'->>'pnlQuote')::numeric) AS exec_pnl_quote
       FROM strategy_outcomes
      WHERE is_simulated
        AND exit_at IS NOT NULL
        AND exit_at >= ($1::date::timestamp AT TIME ZONE $3)
        AND exit_at <  (($2::date + 1)::timestamp AT TIME ZONE $3)
        AND coalesce(strategy_id, '') <> ALL($4::text[])
      GROUP BY 1
      ORDER BY 1`,
    args,
  )

  // Same interval-overlap sweep (and the same reason for it) as loadPaperCapital: counting buy/sell
  // records overstates exposure because a position whose close record never landed never decrements.
  const { rows: peaks } = await query<{ day: string; peak_open: number }>(
    `WITH ev AS (
       SELECT entry_at AS ts, 1 AS d
         FROM strategy_outcomes
        WHERE is_simulated
          AND entry_at >= ($1::date::timestamp AT TIME ZONE $3)
          AND entry_at <  (($2::date + 1)::timestamp AT TIME ZONE $3)
          AND coalesce(strategy_id, '') <> ALL($4::text[])
       UNION ALL
       SELECT coalesce(exit_at, NOW()) AS ts, -1 AS d
         FROM strategy_outcomes
        WHERE is_simulated
          AND entry_at >= ($1::date::timestamp AT TIME ZONE $3)
          AND entry_at <  (($2::date + 1)::timestamp AT TIME ZONE $3)
          AND coalesce(strategy_id, '') <> ALL($4::text[])
     ), cum AS (
       SELECT ts, sum(sum(d)) OVER (ORDER BY ts) AS open_now
         FROM ev GROUP BY ts
     )
     SELECT to_char(date_trunc('day', ts AT TIME ZONE $3), 'YYYY-MM-DD') AS day,
            max(open_now)::int AS peak_open
       FROM cum GROUP BY day ORDER BY day`,
    args,
  )

  // Per-regime totals over the range, from the tag stamped at exit — regime sizing is configured
  // per tag, so this is the grouping that decides each bucket's position size.
  // Grouped by the stamped size multiplier rather than by a regime tag: the multiplier is what the
  // sizing system actually applied (and what the outcomes record), while `market_regime_tags` holds
  // a separate vocabulary that has been dormant since 2026-07-10 and is stamped on no recent close.
  const { rows: bySizeMult } = await query<{
    size_mult: string | null
    trades: number
    won: number
    lost: number
    sum_pnl_pct: string | null
  }>(
    `SELECT to_char(coalesce((features->>'ml_size_mult')::numeric, 1), 'FM0.000') AS size_mult,
            count(*)::int AS trades,
            count(*) FILTER (WHERE status = 'won')::int AS won,
            count(*) FILTER (WHERE status = 'lost')::int AS lost,
            sum(pnl_pct) AS sum_pnl_pct
       FROM strategy_outcomes
      WHERE is_simulated
        AND exit_at IS NOT NULL
        AND exit_at >= ($1::date::timestamp AT TIME ZONE $3)
        AND exit_at <  (($2::date + 1)::timestamp AT TIME ZONE $3)
        AND coalesce(strategy_id, '') <> ALL($4::text[])
      GROUP BY 1
      ORDER BY trades DESC
      LIMIT 12`,
    args,
  )

  const { rows: regimeByDay } = await query<{ day: string; regime_tag: string | null }>(
    `SELECT to_char(tag_date, 'YYYY-MM-DD') AS day, regime_tag
       FROM market_regime_tags
      WHERE tag_date >= $1::date AND tag_date <= $2::date
      ORDER BY tag_date`,
    [params.from, params.to],
  ).catch(() => ({ rows: [] as Array<{ day: string; regime_tag: string | null }> }))

  const { rows: byRegimeTag } = await query<{
    regime: string | null
    trades: number
    won: number
    lost: number
    sum_pnl_pct: string | null
  }>(
    `SELECT features->>'regime_tag_at_exit' AS regime,
            count(*)::int AS trades,
            count(*) FILTER (WHERE status = 'won')::int AS won,
            count(*) FILTER (WHERE status = 'lost')::int AS lost,
            sum(pnl_pct) AS sum_pnl_pct
       FROM strategy_outcomes
      WHERE is_simulated
        AND exit_at IS NOT NULL
        AND exit_at >= ($1::date::timestamp AT TIME ZONE $3)
        AND exit_at <  (($2::date + 1)::timestamp AT TIME ZONE $3)
        AND coalesce(strategy_id, '') <> ALL($4::text[])
      GROUP BY 1
      ORDER BY trades DESC
      LIMIT 12`,
    args,
  ).catch(() => ({ rows: [] as Array<{ regime: string | null; trades: number; won: number; lost: number; sum_pnl_pct: string | null }> }))

  return { daily, peaks, bySizeMult, byRegimeTag, regimeByDay }
}

/**
 * Every closed trade on one day, for the dashboard's expandable per-day list. Bounded by the day, so
 * a 90-day range never has to ship thousands of rows at once.
 */
export async function loadDayClosedTrades(params: {
  day: string
  timeZone: string
  limit?: number
  excludeStrategies?: string[]
}): Promise<Array<{
  strategy_id: string
  token_address: string
  token_symbol: string | null
  pnl_pct: string | null
  status: string | null
  regime_tag: string | null
  has_exec: boolean
  entry_at: string | null
  exit_at: string | null
}>> {
  const timeZone = resolveReportTimeZone(params.timeZone)
  const { rows } = await query<{
    strategy_id: string
    token_address: string
    token_symbol: string | null
    pnl_pct: string | null
    status: string | null
    regime_tag: string | null
    has_exec: boolean
    entry_at: string | null
    exit_at: string | null
  }>(
    `SELECT strategy_id,
            token_address,
            features->>'token_symbol' AS token_symbol,
            pnl_pct, status,
            features->>'regime_tag_at_exit' AS regime_tag,
            (features ? 'exec') AS has_exec,
            entry_at, exit_at
       FROM strategy_outcomes
      WHERE is_simulated
        AND exit_at IS NOT NULL
        AND exit_at >= ($1::date::timestamp AT TIME ZONE $2)
        AND exit_at <  (($1::date + 1)::timestamp AT TIME ZONE $2)
        AND coalesce(strategy_id, '') <> ALL($3::text[])
      ORDER BY pnl_pct DESC NULLS LAST
      LIMIT $4`,
    [params.day, timeZone, params.excludeStrategies ?? [], params.limit ?? 2000],
  )
  return rows
}

/** Currently-open PAPER positions, from the SL/TP tracker the sims now register into. */
export async function loadOpenPaperPositions(
  limit = 500,
  excludeStrategies: string[] = [],
): Promise<Array<{
  token_address: string
  token_symbol: string
  strategy_id: string | null
  position_size: string
  entry_price: string
  current_price: string
  stop_loss_price: string
  take_profit_price: string
  created_at: string
}>> {
  const { rows } = await query<{
    token_address: string
    token_symbol: string
    strategy_id: string | null
    position_size: string
    entry_price: string
    current_price: string
    stop_loss_price: string
    take_profit_price: string
    created_at: string
  }>(
    `SELECT token_address, token_symbol, strategy_id, position_size,
            entry_price, current_price, stop_loss_price, take_profit_price, created_at
       FROM sl_tp_positions
      WHERE is_active AND is_simulation
        AND coalesce(strategy_id, '') <> ALL($2::text[])
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit, excludeStrategies],
  ).catch(() => ({ rows: [] as Array<never> }))
  return rows as never
}

/**
 * The sim ledger for a window, shaped for `summarizeLedgerPositions`.
 *
 * Only the fields the reconstruction needs are selected — the full `data` blob is heavy (the table is
 * 265 MB overall), and pulling it for a month of sims would be tens of MB for no reason. `is_simulation`
 * is filtered in SQL and the window bounds are built the same way as every other report query.
 */
export async function loadSimLedgerRecords(params: {
  from: string
  to: string
  timeZone: string
  limit?: number
  excludeStrategies?: string[]
}): Promise<Array<{
  operationType: string
  timestamp: number
  chain: string | null
  tokens: unknown
  solAmount: number | null
  successCount: number | null
  botStrategy: string | null
}>> {
  const timeZone = resolveReportTimeZone(params.timeZone)
  const { rows } = await query<{
    operationType: string | null
    ts: number | null
    chain: string | null
    tokens: unknown
    sol_amount: string | null
    success_count: string | null
    bot_strategy: string | null
  }>(
    `SELECT data->>'operationType' AS "operationType",
            (extract(epoch from timestamp) * 1000)::bigint AS ts,
            coalesce(data->>'chain', 'sol') AS chain,
            data->'tokens' AS tokens,
            data->>'solAmount' AS sol_amount,
            data->>'successCount' AS success_count,
            data->>'bot_strategy' AS bot_strategy
       FROM trading_records
      WHERE data->>'is_simulation' = 'true'
        AND timestamp >= ($1::date::timestamp AT TIME ZONE $3)
        AND timestamp <  (($2::date + 1)::timestamp AT TIME ZONE $3)
        AND coalesce(data->>'bot_strategy', '') <> ALL($4::text[])
       ORDER BY timestamp ASC
       LIMIT $5`,
    [params.from, params.to, timeZone, params.excludeStrategies ?? [], params.limit ?? 40000],
  )
  return rows.map((r) => ({
    operationType: r.operationType ?? '',
    timestamp: Number(r.ts ?? 0),
    chain: r.chain,
    tokens: r.tokens ?? [],
    solAmount: r.sol_amount == null ? null : Number(r.sol_amount),
    successCount: r.success_count == null ? null : Number(r.success_count),
    botStrategy: r.bot_strategy,
  }))
}

export async function aggregateTokenPnlByToken(params: {
  chain?: StrategyChain
  isSimulated: boolean
  from: string
  to: string
  timeZone: string
  limit?: number
}): Promise<{
  tokens: TokenPnlRow[]
  totals: {
    trades: number
    won: number
    lost: number
    priced: number
    avgPnlPct: number
    medianPnlPct: number
    grossWinPct: number
    grossLossPct: number
  }
  /** Chains actually present in the window, so the caller can flag a mixed-unit export. */
  chains: string[]
  peakConcurrent: number
  truncated: boolean
}> {
  const timeZone = resolveReportTimeZone(params.timeZone)
  const limit = params.limit ?? 5000
  const chain = params.chain ?? null
  const windowArgs = [chain, params.isSimulated, params.from, params.to, timeZone]

  const { rows: tokenRows } = await query<{
    token_address: string
    symbol: string | null
    strategies: string[] | null
    trades: number
    won: number
    lost: number
    priced: number
    sum_pnl_pct: string | null
    avg_pnl_pct: string | null
    median_pnl_pct: string | null
    first_entry: Date | null
    last_exit: Date | null
  }>(
    `SELECT o.token_address,
            COALESCE(
              NULLIF(max(m.token_symbol), ''),
              NULLIF(max(o.features->>'token_symbol'), ''),
              left(o.token_address, 6)
            ) AS symbol,
            array_agg(DISTINCT o.strategy_id) AS strategies,
            count(*)::int AS trades,
            count(*) FILTER (WHERE o.status = 'won')::int AS won,
            count(*) FILTER (WHERE o.status = 'lost')::int AS lost,
            count(o.pnl_pct)::int AS priced,
            sum(o.pnl_pct) AS sum_pnl_pct,
            avg(o.pnl_pct) AS avg_pnl_pct,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY o.pnl_pct) AS median_pnl_pct,
            min(o.entry_at) AS first_entry,
            max(o.exit_at) AS last_exit
       FROM strategy_outcomes o
       LEFT JOIN (
         SELECT DISTINCT ON (token_address) token_address, token_symbol
           FROM token_mcap_tracking
          WHERE token_symbol IS NOT NULL AND token_symbol <> ''
          ORDER BY token_address, last_updated_at DESC NULLS LAST
       ) m ON m.token_address = o.token_address
      WHERE ($1::text IS NULL OR o.chain = $1)
        AND o.is_simulated = $2
        AND o.entry_at >= ($3::date::timestamp AT TIME ZONE $5)
        AND o.entry_at <  (($4::date + 1)::timestamp AT TIME ZONE $5)
      GROUP BY o.token_address
      ORDER BY sum(o.pnl_pct) DESC NULLS LAST
      LIMIT $6`,
    [...windowArgs, limit + 1],
  )

  // A per-token median cannot be re-aggregated into a trade median, so the trade-level stats
  // come from their own pass over the same window.
  const { rows: totalRows } = await query<{
    trades: number
    won: number
    lost: number
    priced: number
    avg_pnl_pct: string | null
    median_pnl_pct: string | null
    gross_win_pct: string | null
    gross_loss_pct: string | null
  }>(
    `SELECT count(*)::int AS trades,
            count(*) FILTER (WHERE status = 'won')::int AS won,
            count(*) FILTER (WHERE status = 'lost')::int AS lost,
            count(pnl_pct)::int AS priced,
            avg(pnl_pct) AS avg_pnl_pct,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY pnl_pct) AS median_pnl_pct,
            sum(pnl_pct) FILTER (WHERE pnl_pct > 0) AS gross_win_pct,
            sum(pnl_pct) FILTER (WHERE pnl_pct < 0) AS gross_loss_pct
       FROM strategy_outcomes
      WHERE ($1::text IS NULL OR chain = $1)
        AND is_simulated = $2
        AND entry_at >= ($3::date::timestamp AT TIME ZONE $5)
        AND entry_at <  (($4::date + 1)::timestamp AT TIME ZONE $5)`,
    windowArgs,
  )

  // Peak simultaneous exposure over the window, same interval-overlap sweep (and same reason for
  // it) as loadPaperCapital's per-day peak: buy/sell record counting overstates it badly, because
  // a position whose close record never landed never decrements.
  const { rows: peakRows } = await query<{ peak_open: number | null }>(
    `WITH ev AS (
       SELECT entry_at AS ts, 1 AS d
         FROM strategy_outcomes
        WHERE ($1::text IS NULL OR chain = $1) AND is_simulated = $2
          AND entry_at >= ($3::date::timestamp AT TIME ZONE $5)
          AND entry_at <  (($4::date + 1)::timestamp AT TIME ZONE $5)
       UNION ALL
       SELECT coalesce(exit_at, NOW()) AS ts, -1 AS d
         FROM strategy_outcomes
        WHERE ($1::text IS NULL OR chain = $1) AND is_simulated = $2
          AND entry_at >= ($3::date::timestamp AT TIME ZONE $5)
          AND entry_at <  (($4::date + 1)::timestamp AT TIME ZONE $5)
     ), cum AS (
       SELECT ts, sum(sum(d)) OVER (ORDER BY ts) AS open_now
         FROM ev GROUP BY ts
     )
     SELECT max(open_now)::int AS peak_open FROM cum`,
    windowArgs,
  )

  const { rows: chainRows } = await query<{ chain: string | null }>(
    `SELECT DISTINCT chain
       FROM strategy_outcomes
      WHERE ($1::text IS NULL OR chain = $1)
        AND is_simulated = $2
        AND entry_at >= ($3::date::timestamp AT TIME ZONE $5)
        AND entry_at <  (($4::date + 1)::timestamp AT TIME ZONE $5)
      ORDER BY chain`,
    windowArgs,
  )

  const totals = totalRows[0]
  const truncated = tokenRows.length > limit
  return {
    chains: chainRows.map((c) => c.chain).filter((c): c is string => !!c),
    truncated,
    peakConcurrent: toNum(peakRows[0]?.peak_open),
    tokens: tokenRows.slice(0, limit).map((r) => ({
      tokenAddress: r.token_address,
      symbol: r.symbol ?? '',
      strategies: r.strategies ?? [],
      trades: toNum(r.trades),
      won: toNum(r.won),
      lost: toNum(r.lost),
      priced: toNum(r.priced),
      sumPnlPct: toNum(r.sum_pnl_pct),
      avgPnlPct: toNum(r.avg_pnl_pct),
      medianPnlPct: toNum(r.median_pnl_pct),
      firstEntry: r.first_entry ? r.first_entry.toISOString() : null,
      lastExit: r.last_exit ? r.last_exit.toISOString() : null,
    })),
    totals: {
      trades: toNum(totals?.trades),
      won: toNum(totals?.won),
      lost: toNum(totals?.lost),
      priced: toNum(totals?.priced),
      avgPnlPct: toNum(totals?.avg_pnl_pct),
      medianPnlPct: toNum(totals?.median_pnl_pct),
      grossWinPct: toNum(totals?.gross_win_pct),
      grossLossPct: toNum(totals?.gross_loss_pct),
    },
  }
}

/**
 * What the paper system needs to spend, and what it returned — per day, per chain.
 *
 * Three numbers, deliberately kept separate because they answer different questions:
 * - `deployed` = throughput (sum of buy notional). NOT the capital need: it recycles.
 * - `peak_open` / `peak_capital` = the binding number (peak SIMULTANEOUS exposure across
 *   the chain's sim wallets × the clip actually used).
 * - `profit_factor` / `rr_ratio` = outcome quality. Profit factor is the robust headline
 *   because the expectancy mean is right-tail driven (median is reported beside it).
 *
 * Amounts are in the chain's native unit (SOL vs ETH — the RH twin sizes in ETH), so the
 * caller must render them with `currency` and never sum them across chains.
 */

export async function loadPaperCapital(params: {
  chain: StrategyChain
  days?: number
  timeZone?: string
}): Promise<PaperCapitalSummary> {
  const days = Math.min(Math.max(params.days ?? 3, 1), 30)
  const timeZone = resolveReportTimeZone(params.timeZone ?? DEFAULT_REPORT_TIMEZONE)
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const currency = params.chain === 'robinhood' ? 'ETH' : 'SOL'

  const empty = (): PaperCapitalSummary => ({
    chain: params.chain,
    currency,
    days: [],
    window_days: days,
    totals: {
      trades: 0,
      deployed: 0,
      peak_open: 0,
      peak_capital: 0,
      win_rate: 0,
      profit_factor: null,
      expectancy_pct: 0,
      median_pct: 0,
      avg_win_pct: null,
      avg_loss_pct: null,
      rr_ratio: null,
    },
    observed_clip: 0,
    timezone: timeZone,
  })

  try {
    // Throughput: how much notional the system moved, not what it must hold.
    const { rows: flowRows } = await query<{
      day: string
      buys: number
      deployed: string | null
    }>(
      `SELECT to_char(date_trunc('day', timestamp AT TIME ZONE $3), 'YYYY-MM-DD') AS day,
              count(*)::int AS buys,
              sum(coalesce((data->>'solAmount')::numeric, 0)) AS deployed
         FROM trading_records
        WHERE data->>'is_simulation' = 'true'
          AND data->>'operationType' = 'buy'
          AND coalesce(data->>'chain', 'sol') = $1
          AND timestamp >= $2
        GROUP BY day ORDER BY day`,
      [params.chain, from, timeZone],
    )

    // Peak simultaneous exposure, as a proper interval-overlap sweep over the CLOSED trade
    // intervals (one row per position since the identity fix). Counting buy/sell records
    // instead overstates it badly: a position whose close record never landed never
    // decrements, so the running count grows without bound (measured 1674 "open" positions
    // on a day with ~330 buys). Currently-open positions are counted to now().
    const { rows: peakRows } = await query<{ day: string; peak_open: number }>(
      `WITH ev AS (
         SELECT entry_at AS ts, 1 AS d
           FROM strategy_outcomes
          WHERE chain = $1 AND is_simulated AND entry_at >= $2
         UNION ALL
         SELECT coalesce(exit_at, NOW()) AS ts, -1 AS d
           FROM strategy_outcomes
          WHERE chain = $1 AND is_simulated AND entry_at >= $2
       ), cum AS (
         SELECT ts, sum(sum(d)) OVER (ORDER BY ts) AS open_now
           FROM ev GROUP BY ts
       )
       SELECT to_char(date_trunc('day', ts AT TIME ZONE $3), 'YYYY-MM-DD') AS day,
              max(open_now)::int AS peak_open
         FROM cum GROUP BY day ORDER BY day`,
      [params.chain, from, timeZone],
    )

    const { rows: clipRows } = await query<{ clip: string | null }>(
      `SELECT (percentile_cont(0.5) WITHIN GROUP (ORDER BY (data->>'solAmount')::numeric)) AS clip
         FROM trading_records
        WHERE data->>'is_simulation' = 'true'
          AND data->>'operationType' = 'buy'
          AND coalesce(data->>'chain', 'sol') = $1
          AND timestamp >= $2
          AND (data->>'solAmount') IS NOT NULL`,
      [params.chain, from],
    )
    const observedClip = clipRows[0]?.clip == null ? 0 : Number(clipRows[0].clip)

    const { rows: pnlRows } = await query<{
      day: string
      trades: number
      wins: number
      losses: number
      sum_wins: string | null
      sum_losses: string | null
      expectation: string | null
      median: string | null
      avg_win: string | null
      avg_loss: string | null
    }>(
      `SELECT to_char(date_trunc('day', exit_at AT TIME ZONE $3), 'YYYY-MM-DD') AS day,
              count(*)::int AS trades,
              count(*) FILTER (WHERE pnl_pct > 1e-6)::int AS wins,
              count(*) FILTER (WHERE pnl_pct < -1e-6)::int AS losses,
              sum(pnl_pct) FILTER (WHERE pnl_pct > 1e-6) AS sum_wins,
              sum(pnl_pct) FILTER (WHERE pnl_pct < -1e-6) AS sum_losses,
              avg(pnl_pct) AS expectation,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY pnl_pct) AS median,
              avg(pnl_pct) FILTER (WHERE pnl_pct > 1e-6) AS avg_win,
              avg(pnl_pct) FILTER (WHERE pnl_pct < -1e-6) AS avg_loss
         FROM strategy_outcomes
        WHERE chain = $1 AND is_simulated AND exit_at >= $2
        GROUP BY day ORDER BY day`,
      [params.chain, from, timeZone],
    )

    const num = (v: string | null | undefined): number | null =>
      v == null ? null : Number(v)
    const peakByDay = new Map(peakRows.map((r) => [r.day, Number(r.peak_open)]))
    const pnlByDay = new Map(pnlRows.map((r) => [r.day, r]))

    const allDays = [...new Set([...flowRows.map((r) => r.day), ...pnlRows.map((r) => r.day)])]
      .sort()
      .map((day) => {
        const flow = flowRows.find((r) => r.day === day)
        const pnl = pnlByDay.get(day)
        const sumWins = num(pnl?.sum_wins)
        const sumLosses = num(pnl?.sum_losses)
        const avgWin = num(pnl?.avg_win)
        const avgLoss = num(pnl?.avg_loss)
        const peakOpen = peakByDay.get(day) ?? 0
        const trades = pnl?.trades ?? 0
        const wins = pnl?.wins ?? 0
        return {
          day,
          buys: flow?.buys ?? 0,
          deployed: num(flow?.deployed) ?? 0,
          peak_open: peakOpen,
          peak_capital: peakOpen * observedClip,
          trades,
          wins,
          losses: pnl?.losses ?? 0,
          win_rate: trades > 0 ? wins / trades : 0,
          profit_factor:
            sumWins != null && sumLosses != null && sumLosses !== 0
              ? sumWins / Math.abs(sumLosses)
              : null,
          expectancy_pct: num(pnl?.expectation) ?? 0,
          median_pct: num(pnl?.median) ?? 0,
          avg_win_pct: avgWin,
          avg_loss_pct: avgLoss,
          rr_ratio:
            avgWin != null && avgLoss != null && avgLoss !== 0
              ? avgWin / Math.abs(avgLoss)
              : null,
        }
      })

    // Totals come from the raw per-day sums, not from avg × count: the averages are
    // rounded by the aggregate and reconstructing the sums from them loses precision.
    const totalTrades = pnlRows.reduce((s, r) => s + r.trades, 0)
    const winTrades = pnlRows.reduce((s, r) => s + r.wins, 0)
    const lossTrades = pnlRows.reduce((s, r) => s + r.losses, 0)
    const sumWins = pnlRows.reduce((s, r) => s + (num(r.sum_wins) ?? 0), 0)
    const sumLosses = pnlRows.reduce((s, r) => s + (num(r.sum_losses) ?? 0), 0)
    const peakOpen = allDays.reduce((s, d) => Math.max(s, d.peak_open), 0)

    return {
      chain: params.chain,
      currency,
      days: allDays,
      window_days: days,
      totals: {
        trades: totalTrades,
        deployed: allDays.reduce((s, d) => s + d.deployed, 0),
        peak_open: peakOpen,
        peak_capital: peakOpen * observedClip,
        win_rate: totalTrades > 0 ? winTrades / totalTrades : 0,
        profit_factor:
          sumLosses !== 0 && winTrades > 0
            ? sumWins / Math.abs(sumLosses)
            : null,
        expectancy_pct:
          totalTrades > 0
            ? allDays.reduce((s, d) => s + d.expectancy_pct * d.trades, 0) / totalTrades
            : 0,
        median_pct:
          allDays.length > 0
            ? allDays.reduce((s, d) => s + d.median_pct, 0) / allDays.length
            : 0,
        avg_win_pct: winTrades > 0 ? sumWins / winTrades : null,
        avg_loss_pct: lossTrades > 0 ? sumLosses / lossTrades : null,
        rr_ratio:
          winTrades > 0 && lossTrades > 0 && sumLosses !== 0
            ? sumWins / winTrades / Math.abs(sumLosses / lossTrades)
            : null,
      },
      observed_clip: observedClip,
      timezone: timeZone,
    }
  } catch (error) {
    if (isMissingSchemaError(error)) return empty()
    console.warn('[strategies/db] paper capital failed:', errorMessage(error))
    return empty()
  }
}

export async function aggregateStrategyReports(params: {
  domain?: StrategyDomain
  chain?: StrategyChain
  strategyId?: string
  isSimulated?: boolean
  from?: string
  to?: string
  timeZone?: string
  /**
   * Sections the caller already has (the `report_precompute` worker stores them per filter
   * shape). Supplying one skips its DB round trips; the values are identical because they
   * are produced by the same loaders with the same filters.
   */
  precomputed?: {
    consensus?: ConsensusTestResult | null
    capital?: PaperCapitalSummary[] | null
  }
}): Promise<{
  breakdown: StrategyReportBreakdown[]
  abPairs: import('./types').StrategyAbPair[]
  topTrades: StrategyOutcomeRow[]
  worstTrades: StrategyOutcomeRow[]
  coverage: StrategyCoverageRow[]
  mlStats: MlLabelStats
  mcapTrackerStats: McapTrackerReportStats
  bestTradeWindows: StrategyBestTradeWindows[]
  overlap: StrategyOverlapRow[]
  pairs: StrategyPairOverlapRow[]
  consensus: ConsensusTestResult
  /** One entry per chain (native units differ, so they are never summed together). */
  capital: PaperCapitalSummary[]
  timezone: string
}> {
  const timeZone = resolveReportTimeZone(params.timeZone ?? DEFAULT_REPORT_TIMEZONE)
  const emptyMcapStats: McapTrackerReportStats = {
    strategies: [],
    milestone_buckets: [],
    timeline_inconsistent_count: 0,
    total_tracked_tokens: 0,
    open_sim_positions: [],
  }

  const { sql: whereSql, values } = buildOutcomeWhereClause(params)

  let rows: StrategyOutcomeRow[]
  try {
    const result = await query<Record<string, unknown>>(
      // Project what mapStrategyOutcomeRow actually reads: `SELECT *` pulled every
      // row (82k across domains) with the whole features JSONB for a report that
      // only needs these columns.
      `SELECT id, strategy_id, domain, chain, token_address, entry_at, exit_at,
              pnl_pct, status, is_simulated, features, created_at
       FROM strategy_outcomes ${whereSql}`,
      values,
    )
    rows = dedupeStrategyOutcomeRows(result.rows.map(mapStrategyOutcomeRow))
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return {
        breakdown: [],
        abPairs: [],
        topTrades: [],
        worstTrades: [],
        coverage: [],
        mlStats: { total: 0, unlabeled: 0, by_label: {}, by_condition: {} },
        mcapTrackerStats: emptyMcapStats,
        bestTradeWindows: [],
        overlap: [],
        pairs: [],
        consensus: runConsensusTest([]),
        capital: [],
        timezone: timeZone,
      }
    }
    throw error
  }

  const groups = new Map<string, StrategyOutcomeRow[]>()

  for (const row of rows) {
    const key = `${row.domain}|${row.strategy_id}|${row.is_simulated}`
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  }

  const breakdown: StrategyReportBreakdown[] = []

  for (const [key, groupRows] of Array.from(groups.entries())) {
    const [domain, strategy_id, simStr] = key.split('|')
    const pnls = groupRows
      .map((r: StrategyOutcomeRow) => (r.pnl_pct != null ? Number(r.pnl_pct) : null))
      .filter((v: number | null): v is number => v != null)
    const summary = summarizeClosedPnls(pnls)
    const wins = summary.winCount
    const losses = summary.lossCount
    const exitTimes = groupRows
      .map((r) => r.exit_at)
      .filter((v): v is string => !!v)
      .sort()
    const lastExitAt = exitTimes.length ? exitTimes[exitTimes.length - 1] : null

    breakdown.push({
      strategy_id,
      domain: domain as StrategyDomain,
      is_simulated: simStr === 'true',
      trade_count: groupRows.length,
      win_count: wins,
      loss_count: losses,
      win_rate: groupRows.length ? wins / groupRows.length : 0,
      avg_pnl_pct: pnls.length ? pnls.reduce((a: number, b: number) => a + b, 0) / pnls.length : 0,
      median_pnl_pct: median(pnls),
      total_pnl_pct: pnls.reduce((a: number, b: number) => a + b, 0),
      last_exit_at: lastExitAt,
    })
  }

  breakdown.sort((a, b) => b.win_rate - a.win_rate)

  const defRows = await loadStrategyDefinitionRows(undefined, params.chain)
  let breakdownByKey = new Map(
    breakdown.map((b) => [`${b.domain}|${b.strategy_id}|${b.is_simulated}`, b]),
  )

  for (const def of defRows) {
    for (const isSim of [true, false] as const) {
      const key = `${def.domain}|${def.id}|${isSim}`
      if (breakdownByKey.has(key)) continue
      breakdown.push({
        strategy_id: def.id,
        domain: def.domain,
        is_simulated: isSim,
        trade_count: 0,
        win_count: 0,
        loss_count: 0,
        win_rate: 0,
        avg_pnl_pct: 0,
        median_pnl_pct: 0,
        total_pnl_pct: 0,
        last_exit_at: null,
      })
    }
  }

  breakdown.sort((a, b) => {
    if (a.trade_count !== b.trade_count) return b.trade_count - a.trade_count
    return a.strategy_id.localeCompare(b.strategy_id)
  })

  // Rebuilt after the synthetic zero rows are merged, so coverage/abPairs can look
  // rows up by key instead of scanning `breakdown` per definition.
  breakdownByKey = new Map(
    breakdown.map((b) => [`${b.domain}|${b.strategy_id}|${b.is_simulated}`, b]),
  )
  const defById = new Map(defRows.map((d) => [d.id, d]))

  const mlByStrategy = new Map<string, { unlabeled: number; labeled: number }>()
  for (const row of rows) {
    const cur = mlByStrategy.get(row.strategy_id) ?? { unlabeled: 0, labeled: 0 }
    const label = row.features?.ml_label
    if (typeof label === 'string' && label.trim()) {
      cur.labeled++
    } else {
      cur.unlabeled++
    }
    mlByStrategy.set(row.strategy_id, cur)
  }

  const openByStrategy = new Map<string, number>()
  const trackerTable = getTrackerTableName()
  try {
    const { rows: trackerRows } = await query<{
      status: string
      trading_simulation: Record<string, unknown> | null
    }>(
      `SELECT status, trading_simulation FROM ${trackerTable} WHERE status = 'tracking'`,
    )
    for (const row of trackerRows) {
      if (!isOpenTrackerPosition(row)) continue
      const sid = resolveTrackerStrategyId(
        row.trading_simulation as Record<string, unknown> | null | undefined,
      )
      if (!sid) continue
      openByStrategy.set(sid, (openByStrategy.get(sid) ?? 0) + 1)
    }
  } catch (error) {
    if (!isMissingSchemaError(error)) {
      console.warn(
        '[strategies/db] tracker open count failed:',
        errorMessage(error),
      )
    }
  }

  const mcapOpenByStrategy = new Map<string, number>()
  // One read and ONE reconstruction per request. The reconstruction is quadratic in the
  // record count (a full scan per token) and used to run once per definition here and
  // again per definition for the open-positions list — 14 passes over the sim history.
  const mcapSimRecords = await loadMcapSimRecords()
  const mcapOpenPositions = await buildOpenMcapSimReportPositions(mcapSimRecords)
  for (const position of mcapOpenPositions) {
    mcapOpenByStrategy.set(
      position.strategy_id,
      (mcapOpenByStrategy.get(position.strategy_id) ?? 0) + 1,
    )
  }

  const coverage: StrategyCoverageRow[] = defRows.map((def) => {
    const sim = breakdownByKey.get(`${def.domain}|${def.id}|true`)
    const live = breakdownByKey.get(`${def.domain}|${def.id}|false`)
    const simLast = sim?.last_exit_at ?? null
    const liveLast = live?.last_exit_at ?? null
    const lastExitAt =
      simLast && liveLast
        ? simLast > liveLast
          ? simLast
          : liveLast
        : simLast ?? liveLast

    return {
      strategy_id: def.id,
      domain: def.domain,
      name: def.name,
      is_active: def.is_active,
      execution_mode: def.execution_mode,
      sim_trade_count: sim?.trade_count ?? 0,
      live_trade_count: live?.trade_count ?? 0,
      last_exit_at: lastExitAt,
      avg_pnl_pct: sim?.trade_count ? sim.avg_pnl_pct : null,
      open_tracker_count:
        def.domain === 'trending_bot'
          ? openByStrategy.get(def.id) ?? 0
          : def.domain === 'mcap_tracker'
            ? mcapOpenByStrategy.get(def.id) ?? 0
            : null,
      ml_unlabeled: mlByStrategy.get(def.id)?.unlabeled ?? 0,
      ml_labeled: mlByStrategy.get(def.id)?.labeled ?? 0,
    }
  })
  const abParallelIds = defRows
    .filter(
      (d) =>
        d.execution_mode === 'ab_parallel' && d.domain !== 'trending_bot',
    )
    .map((d) => d.id)

  const abPairs: import('./types').StrategyAbPair[] = abParallelIds.map((id) => {
    const domain = defById.get(id)?.domain ?? 'trending_bot'
    const sim = breakdownByKey.get(`${domain}|${id}|true`) ?? null
    const live = breakdownByKey.get(`${domain}|${id}|false`) ?? null
    return { strategy_id: id, domain: domain as StrategyDomain, sim, live }
  })

  const withPnl = rows.filter((r) => r.pnl_pct != null)
  const topTrades = [...withPnl]
    .sort((a, b) => Number(b.pnl_pct) - Number(a.pnl_pct))
    .slice(0, 8)
  const worstTrades = [...withPnl]
    .sort((a, b) => Number(a.pnl_pct) - Number(b.pnl_pct))
    .slice(0, 8)

  const mlStats = computeMlLabelStats(rows)
  const mcapTrackerStats = await buildMcapTrackerReportStats(
    rows,
    breakdown,
    mcapSimRecords,
    mcapOpenPositions,
  )
  const bestTradeWindows = computeBestTradeWindows(rows, { timeZone })

  const [overlap, pairs, consensus] = await Promise.all([
    loadTokenStrategyOverlap(params),
    loadStrategyPairOverlap(params),
    params.precomputed?.consensus
      ? Promise.resolve(params.precomputed.consensus)
      : loadConsensusTest(params),
  ])
  // Chain-scoped like the rest of the report (parseStrategyChain always resolves one), so
  // the RH/ETH block appears with ?chain=robinhood. Units differ per chain, so a single
  // block is the honest shape.
  const capital = params.precomputed?.capital?.length
    ? params.precomputed.capital
    : [await loadPaperCapital({ chain: params.chain ?? 'sol', days: 3, timeZone })]

  return {
    breakdown,
    abPairs,
    topTrades,
    worstTrades,
    coverage,
    mlStats,
    mcapTrackerStats,
    bestTradeWindows,
    overlap,
    pairs,
    consensus,
    capital,
    timezone: timeZone,
  }
}

export type StrategyDomainHeartbeatSource =
  | 'outcome'
  | 'position_close'
  | 'position_activity'
  | 'worker'

export type StrategyDomainHeartbeat = {
  domain: StrategyDomain
  last_outcome_at: string | null
  heartbeat_source?: StrategyDomainHeartbeatSource
}

async function getLatestOutcomeHeartbeat(
  domain: StrategyDomain,
): Promise<{ last_outcome_at: string | null; heartbeat_source?: StrategyDomainHeartbeatSource }> {
  try {
    const row = await queryOne<{ exit_at: string | null; created_at: string | null }>(
      `SELECT exit_at, created_at FROM strategy_outcomes
       WHERE domain = $1
       ORDER BY exit_at DESC NULLS LAST
       LIMIT 1`,
      [domain],
    )

    const lastOutcomeAt = toIsoOrNull(row?.exit_at) ?? toIsoOrNull(row?.created_at)
    if (!lastOutcomeAt) return { last_outcome_at: null }
    return { last_outcome_at: lastOutcomeAt, heartbeat_source: 'outcome' }
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return { last_outcome_at: null }
    }
    console.warn(
      `[strategies/db] domain heartbeat failed (${domain}):`,
      errorMessage(error),
    )
    return { last_outcome_at: null }
  }
}

export async function getDlmmPositionHeartbeats(): Promise<{
  last_closed_at: string | null
  last_activity_at: string | null
}> {
  const [closedRow, activityRow] = await Promise.all([
    queryOne<{ closed_at: string | null }>(
      `SELECT closed_at FROM dlmm_positions
       WHERE status = 'closed' AND closed_at IS NOT NULL
       ORDER BY closed_at DESC
       LIMIT 1`,
    ).catch((error) => {
      if (!isMissingSchemaError(error)) {
        console.warn(
          '[strategies/db] dlmm closed heartbeat failed:',
          errorMessage(error),
        )
      }
      return null
    }),
    queryOne<{ last_decision_at: string | null }>(
      `SELECT last_decision_at FROM dlmm_positions
       WHERE last_decision_at IS NOT NULL
       ORDER BY last_decision_at DESC
       LIMIT 1`,
    ).catch((error) => {
      if (!isMissingSchemaError(error)) {
        console.warn(
          '[strategies/db] dlmm activity heartbeat failed:',
          errorMessage(error),
        )
      }
      return null
    }),
  ])

  return {
    last_closed_at: toIsoOrNull(closedRow?.closed_at),
    last_activity_at: toIsoOrNull(activityRow?.last_decision_at),
  }
}

async function getDlmmDomainHeartbeat(params?: {
  dlmmWorkerLastSuccessAt?: string | null
}): Promise<StrategyDomainHeartbeat> {
  const outcome = await getLatestOutcomeHeartbeat('dlmm')
  if (outcome.last_outcome_at) {
    return { domain: 'dlmm', ...outcome }
  }

  const positions = await getDlmmPositionHeartbeats()
  if (positions.last_closed_at) {
    return {
      domain: 'dlmm',
      last_outcome_at: positions.last_closed_at,
      heartbeat_source: 'position_close',
    }
  }

  if (positions.last_activity_at) {
    return {
      domain: 'dlmm',
      last_outcome_at: positions.last_activity_at,
      heartbeat_source: 'position_activity',
    }
  }

  const workerAt = params?.dlmmWorkerLastSuccessAt?.trim()
  if (workerAt) {
    return {
      domain: 'dlmm',
      last_outcome_at: workerAt,
      heartbeat_source: 'worker',
    }
  }

  return { domain: 'dlmm', last_outcome_at: null }
}

export async function getStrategyDomainHeartbeats(params?: {
  dlmmWorkerLastSuccessAt?: string | null
  workerLastSuccessById?: Record<string, string | null | undefined>
}): Promise<StrategyDomainHeartbeat[]> {
  const domains: StrategyDomain[] = [
    'signals',
    'trending_bot',
    'dlmm',
    'mcap_tracker',
    'gmgn',
    'social',
  ]
  if (!process.env.DATABASE_URL?.trim()) {
    return domains.map((domain) => ({ domain, last_outcome_at: null }))
  }
  const results: StrategyDomainHeartbeat[] = []
  const workerById = params?.workerLastSuccessById ?? {}

  const domainPrimaryWorkers: Record<StrategyDomain, string[]> = {
    mcap_tracker: ['mcap_tracker_sim_track'],
    signals: ['signals_sim_track', 'signals_refresh'],
    trending_bot: ['trending_tracker'],
    dlmm: ['dlmm_manage'],
    gmgn: [
      'gmgn_sim_track',
      'gmgn_activity_poll',
      'gmgn_radar_digest',
      'gmgn_wallet_digger',
    ],
    social: ['social_sim_track'],
  }

  for (const domain of domains) {
    if (domain === 'dlmm') {
      results.push(
        await getDlmmDomainHeartbeat({
          dlmmWorkerLastSuccessAt:
            params?.dlmmWorkerLastSuccessAt ?? workerById.dlmm_manage ?? null,
        }),
      )
      continue
    }

    const outcome = await getLatestOutcomeHeartbeat(domain)
    if (outcome.last_outcome_at) {
      results.push({ domain, ...outcome })
      continue
    }

    let workerAt: string | null = null
    for (const workerId of domainPrimaryWorkers[domain] ?? []) {
      const at = workerById[workerId]?.trim()
      if (at) {
        workerAt = at
        break
      }
    }

    if (workerAt) {
      results.push({
        domain,
        last_outcome_at: workerAt,
        heartbeat_source: 'worker',
      })
      continue
    }

    results.push({ domain, ...outcome })
  }

  return results
}

/**
 * Every trading record for a wallet, ascending (callers depend on the order:
 * `openPositionsFor` and `computeOpenSimCycles` both walk by time).
 *
 * Unbounded by default — historical behaviour. Pass `opts` to bound it: the Robinhood
 * trending sim wallet holds ~155k rows / 151 MB, and hydrating all of it measured
 * 19-78 s inside the same Node process that serves every other cron job, which is what
 * starved the mcap sim past its 30 s deadline.
 *
 * `sinceDays` is a *cycle* bound, not a convenience: an open position whose opening buy
 * falls outside the window can no longer be reconstructed, so it reads as closed. The
 * window must therefore exceed the oldest open position — verify with
 *   WITH r AS (SELECT data->'tokens'->0->>'mintAddress' AS mint,
 *       min(timestamp) FILTER (WHERE data->>'operationType'='buy') AS first_buy,
 *       count(*) FILTER (WHERE data->>'operationType'='buy') AS b,
 *       count(*) FILTER (WHERE data->>'operationType'='sell'
 *                         AND data->>'close_position'='true') AS c
 *     FROM trading_records WHERE wallet_address = $1 GROUP BY 1)
 *   SELECT count(*) FILTER (WHERE first_buy < now() - interval '<window>') FROM r WHERE b > c;
 * (2026-09-29: oldest open att_rh position was 10 days, so 7 d would have been unsafe and
 * 14 d was not.)
 */
/**
 * Hard ceiling on how far back a `trading_records` read may go, in days.
 *
 * Why a floor rather than trusting each caller. The reconstruction read is bounded by "since the last
 * close of this (strategy, mint)", which is correct but has no lower limit: a key that has never
 * closed falls back to `to_timestamp(0)` — deliberately, since an INNER JOIN would drop never-closed
 * keys and make still-open positions vanish — and that reads the wallet's ENTIRE history. Measured on
 * 2026-10-03: `trading_records` is 164,382 rows / 270 MB and **one wallet holds 155,054 of them**.
 * Those reads saturated the connection pool (`[db-pool] idle=0`, connections dying with "Connection
 * terminated unexpectedly"), which slowed the SL/TP pass past its 120s client timeout and cost roughly
 * three quarters of the exit throughput.
 *
 * A 4-day floor reads **1.09%** of that table (1,799 rows) and takes the offending wallet from 155,054
 * rows to 92. It is only safe while every OPEN position is younger than the window — measured at the
 * time of writing as 68.5 hours against a 96-hour window, a 27-hour margin. The watchdog asserts that
 * margin separately, because a floor exceeding the oldest open position would silently stop
 * reconstructing a live position.
 *
 * Env-tunable; delete the variable to return to the default, which is **0 — off**. It was shipped as
 * 4 by `75d5478` and had to be disabled within the hour: 4 days is safe for a position the WORKER
 * manages (`sl_tp_positions`, oldest 68.5 h) but not for the RECONSTRUCTION, which reads
 * `trading_records` and derives "open" cycles from buys with no later close. Those were measured at
 * 83–92 days (`mcap-tracker-sim` 84, `signals-strategy-sim` 92, `gmgn-sim` 83), so a 4-day window
 * erases them, `getOpenMcapPositions` reports "closed", and the sim **re-opens a duplicate** —
 * silently. The default is therefore 0: a fresh deploy must not be able to reintroduce that by
 * omitting a variable. See docs/specs/SPEC-trading-records-index-and-window-v1.md, and the sibling
 * SPEC-trading-records-read-cost-v1.md whose Task 1 (reconcile those cycles) is the prerequisite for
 * any non-zero value.
 *
 * `0` is also correct on its own merits now: the index added in `f6b3665` makes the unbounded read
 * ~12 ms on `mcap-tracker-sim` and 620 ms on the 155k-row wallet, against 120 s before it.
 */
function tradingRecordsMaxAgeDays(): number {
  const raw = Number(process.env.TRADING_RECORDS_MAX_AGE_DAYS)
  if (Number.isFinite(raw) && raw >= 0) return raw
  return 0
}

export async function fetchTradingRecordsForWallet(
  walletAddress: string,
  opts?: { strategies?: string[]; sinceDays?: number; sinceLastClose?: boolean },
): Promise<import('@/utils/trading-tracker').TrackingRecord[]> {
  // Same read, not repeated. Several callers ask for the same wallet several times in one pass;
  // the value is unchanged, and every writer invalidates the wallet (see wallet-records-cache.ts
  // for the measurement and the safety argument).
  const cacheKey = walletRecordsCacheKey(walletAddress, opts)
  const cached = readWalletRecordsCache<import('@/utils/trading-tracker').TrackingRecord>(cacheKey)
  if (cached) return cached
  try {
    // `sinceLastClose` returns only the rows the position reconstruction actually needs.
    //
    // The bound is per (strategy, mint), NOT per mint: each strategy holds its own cycle on a
    // mint, so a close by ONE strategy must not truncate another strategy's still-open cycle.
    // Measured against prod, the per-mint bound changed the reconstructed open set for 4 of
    // the 7 active mcap strategies; this one is exact (0 of 7 differ, 2,095 records instead
    // of 5,283). It is a superset of the per-mint bound, so callers that were already exact
    // with the wider key stay exact.
    if (opts?.sinceLastClose) {
      const strategyCondition = opts.strategies?.length
        ? `AND t.data->>'bot_strategy' = ANY($2::text[])`
        : ''
      const strategyValues = opts.strategies?.length ? [opts.strategies] : []
      // Shape matters here, not just semantics. Written as a CTE joined directly onto
      // `trading_records`, the planner estimated `last_close` at rows=1 and chose a Nested Loop
      // over a Materialize — re-reading the 1,350-row CTE once per trading row:
      //
      //   Nested Loop Left Join  actual time=2282ms..120,096ms   rows=1360
      //     Rows Removed by Join Filter: 110,031,740
      //     -> Materialize  rows=711  loops=155,022
      //     -> Parallel Seq Scan on trading_records  Sort Method: external merge Disk: 64MB+46MB+46MB
      //
      // That is 120s to return 1,360 rows. Joining on the JSONB expressions makes the key
      // unhashable, so extracting (strategy, mint) once into `scoped` lets it hash-join instead.
      // The epoch fallback and the (strategy, mint) key are unchanged — an INNER JOIN would drop
      // never-closed keys and make still-open positions vanish. Differential-checked on prod
      // against the previous query on one snapshot, both wallets: identical id sets
      // (trending-bot-sim-rh 1369/1369, mcap-tracker-sim 2609/2609, 0 rows differing either way).
      // 120,096ms -> 861ms, and the sort is now a 1.2MB quicksort instead of disk spills.
      // The same hard floor as the unbounded branch below, applied with `greatest` so it can only
      // RAISE the start of the window: the later of "since this key last closed" and "N days ago".
      // The epoch fallback inside `coalesce` is what makes a never-closed key read everything, which
      // is the shape that saturated the pool; `greatest` bounds it without dropping the key.
      const maxAgeDaysForLastClose = tradingRecordsMaxAgeDays()
      const maxAgeFloor =
        maxAgeDaysForLastClose > 0
          ? `NOW() - make_interval(days => ${maxAgeDaysForLastClose})`
          : `to_timestamp(0)`

      const { rows } = await query<{ data: import('@/utils/trading-tracker').TrackingRecord }>(
        `WITH scoped AS (
           SELECT t.id, t.timestamp,
                  t.data->>'bot_strategy' AS strategy,
                  t.data->'tokens'->0->>'mintAddress' AS mint,
                  t.data->>'operationType' AS op,
                  t.data->>'close_position' AS closed
             FROM trading_records t
            WHERE t.wallet_address = $1
              ${strategyCondition}
         ),
         last_close AS (
           SELECT strategy, mint, max(timestamp) AS ts
             FROM scoped
            WHERE op = 'sell' AND closed = 'true'
            GROUP BY 1, 2
         )
         SELECT t.data FROM trading_records t
           JOIN scoped s ON s.id = t.id
           LEFT JOIN last_close lc
             ON lc.mint = s.mint
            AND lc.strategy = s.strategy
          WHERE s.timestamp >= CASE
                  -- A key that HAS closed: bound it. The floor can only RAISE the start of the
                  -- window, so the per-(strategy, mint) bound survives and the read is capped.
                  WHEN lc.ts IS NOT NULL THEN greatest(lc.ts, ${maxAgeFloor})
                  -- A key that has NEVER closed — i.e. a still-open position. Deliberately UNBOUNDED,
                  -- unchanged from before: db-paper-capital.test.ts pins this ("the epoch fallback,
                  -- unchanged: a (strategy, mint) with no recorded close keeps every row, so a
                  -- still-open position cannot read as closed"). Applying the floor here is exactly
                  -- the bug it prevents — a live position older than the window would reconstruct as
                  -- absent. The note at db.ts:3250 records the same hazard from 29/09, when an open
                  -- att_rh position was 10 days old.
                  ELSE coalesce(lc.ts, to_timestamp(0))
                END
          ORDER BY s.timestamp ASC`,
        [walletAddress, ...strategyValues],
      )
      const sinceLastCloseRecords = rows.map((r) =>
        typeof r.data === 'string'
          ? (JSON.parse(r.data) as import('@/utils/trading-tracker').TrackingRecord)
          : r.data,
      )
      writeWalletRecordsCache(cacheKey, sinceLastCloseRecords)
      return sinceLastCloseRecords
    }

    const conditions = ['wallet_address = $1']
    const values: unknown[] = [walletAddress]

    if (opts?.strategies && opts.strategies.length > 0) {
      values.push(opts.strategies)
      conditions.push(`data->>'bot_strategy' = ANY($${values.length}::text[])`)
    }
    if (opts?.sinceDays != null && opts.sinceDays > 0) {
      values.push(opts.sinceDays)
      conditions.push(`timestamp >= NOW() - make_interval(days => $${values.length}::int)`)
    }

    // The floor, when configured. `sinceDays` can only TIGHTEN it — a caller asking for 1 day gets 1 day.
    // The default is 0 (OFF): with no `TRADING_RECORDS_MAX_AGE_DAYS` set a caller asking for nothing gets
    // the whole wallet, which the `trading_records` index from f6b3665 makes cheap. A non-zero value
    // is opt-in and must not be set until the 83–92-day reconstructed cycles are reconciled.
    const maxAgeDays = tradingRecordsMaxAgeDays()
    if (maxAgeDays > 0) {
      values.push(maxAgeDays)
      conditions.push(`timestamp >= NOW() - make_interval(days => $${values.length}::int)`)
    }

    const { rows } = await query<{ data: import('@/utils/trading-tracker').TrackingRecord }>(
      `SELECT data FROM trading_records
       WHERE ${conditions.join(' AND ')}
       ORDER BY timestamp ASC`,
      values,
    )
    const records = rows.map((r) =>
      typeof r.data === 'string'
        ? (JSON.parse(r.data) as import('@/utils/trading-tracker').TrackingRecord)
        : r.data,
    )
    writeWalletRecordsCache(cacheKey, records)
    return records
  } catch (error) {
    // THROW. This used to return `[]`, and every caller reads `[]` as "this wallet has no records":
    // the closer concluded "nothing open, already closed" and retired the mirror with no sell and
    // no outcome (Snoopy[tp300], 2026-10-03), and the open gate saw zero open positions. An
    // unreadable ledger is not an empty ledger. Callers catch per position / per strategy.
    console.error('[strategies/db] trading_records fetch failed:', errorMessage(error), {
      wallet: walletAddress,
    })
    throw error
  }
}

/** @deprecated use Record<string, unknown> config in upsert */
export type { TrendingBotStrategyOverride }
