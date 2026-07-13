import { query, queryOne } from '@/utils/db'
import { isMissingSchemaError } from '@/utils/db-health'
import { getTrackingHealthStats, computeMcapSimPnlPct } from '@/utils/mcap-tracker'
import { countOpenMcapSimPositions, getOpenMcapSimPositions } from '@/utils/mcap-sim-track'
import { readTokenSymbol, readTrainingClass } from './outcome-features'
import { dedupeStrategyOutcomeRows, mcapSimClosedOutcomeKey } from './outcome-dedupe'
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
import type {
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
} from './types'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  domain?: StrategyDomain
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
}

function buildOutcomeWhereClause(params: OutcomeFilterParams): {
  sql: string
  values: unknown[]
} {
  const conditions: string[] = []
  const values: unknown[] = []

  if (params.strategyId) {
    values.push(params.strategyId)
    conditions.push(`strategy_id = $${values.length}`)
  }
  if (params.domain) {
    values.push(params.domain)
    conditions.push(`domain = $${values.length}`)
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
    values.push(params.tokenAddress)
    conditions.push(`token_address = $${values.length}`)
  }

  const sql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return { sql, values }
}

export async function loadStrategyDefinitionRows(
  domain?: StrategyDomain,
): Promise<StrategyDefinitionRow[]> {
  try {
    if (domain) {
      const { rows } = await query<Record<string, unknown>>(
        `SELECT * FROM strategy_definitions WHERE domain = $1`,
        [domain],
      )
      return rows.map(mapStrategyDefinitionRow)
    }

    const { rows } = await query<Record<string, unknown>>(
      `SELECT * FROM strategy_definitions`,
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
  name: string
  description?: string | null
  config: Record<string, unknown>
  is_active: boolean
  execution_mode?: ExecutionMode
}): Promise<{ ok: boolean; error?: string }> {
  const updatedAt = new Date().toISOString()
  const configJson = JSON.stringify(params.config)

  try {
    if (params.execution_mode) {
      await query(
        `INSERT INTO strategy_definitions (
           id, domain, name, description, config, is_active, updated_at, execution_mode
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           domain = EXCLUDED.domain,
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           config = EXCLUDED.config,
           is_active = EXCLUDED.is_active,
           updated_at = EXCLUDED.updated_at,
           execution_mode = EXCLUDED.execution_mode`,
        [
          params.id,
          params.domain,
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
           id, domain, name, description, config, is_active, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           domain = EXCLUDED.domain,
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           config = EXCLUDED.config,
           is_active = EXCLUDED.is_active,
           updated_at = EXCLUDED.updated_at`,
        [
          params.id,
          params.domain,
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

export async function loadMcapSimClosedOutcomeKeys(
  strategyId: string,
  tokenAddresses: string[],
): Promise<Set<string>> {
  if (tokenAddresses.length === 0) return new Set()

  try {
    const { rows } = await query<{ token_address: string; entry_at: string }>(
      `SELECT token_address, entry_at FROM strategy_outcomes
       WHERE strategy_id = $1
         AND domain = 'mcap_tracker'
         AND token_address = ANY($2::text[])`,
      [strategyId, tokenAddresses],
    )

    const keys = new Set<string>()
    for (const row of rows) {
      if (row.token_address && row.entry_at) {
        keys.add(mcapSimClosedOutcomeKey(row.token_address, toIso(row.entry_at)))
      }
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

export async function loadRegimeTagForDate(tagDate: string): Promise<string | null> {
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

async function strategyOutcomeExists(params: {
  strategy_id: string
  domain: StrategyDomain
  token_address: string
  entry_at: string
}): Promise<boolean> {
  try {
    const row = await queryOne<{ id: string }>(
      `SELECT id FROM strategy_outcomes
       WHERE strategy_id = $1
         AND domain = $2
         AND token_address = $3
         AND entry_at = $4
       LIMIT 1`,
      [params.strategy_id, params.domain, params.token_address, params.entry_at],
    )
    return !!row
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return false
    }
    console.warn('[strategies/db] strategyOutcomeExists failed:', errorMessage(error))
    return false
  }
}

export async function insertStrategyOutcome(params: {
  strategy_id: string
  domain: StrategyDomain
  token_address: string
  entry_at?: string | null
  exit_at?: string | null
  pnl_pct?: number | null
  status?: string | null
  is_simulated?: boolean
  features?: Record<string, unknown> | null
}): Promise<void> {
  if (
    params.domain === 'mcap_tracker' &&
    params.token_address &&
    params.entry_at
  ) {
    const exists = await strategyOutcomeExists({
      strategy_id: params.strategy_id,
      domain: params.domain,
      token_address: params.token_address,
      entry_at: params.entry_at,
    })
    if (exists) return
  }

  const exitAt = params.exit_at ?? new Date().toISOString()
  let features = params.features ?? {}

  if (params.token_address && params.entry_at && params.domain !== 'dlmm') {
    features = await enrichOutcomeFeaturesWithTracker({
      tokenAddress: params.token_address,
      entryAt: params.entry_at,
      exitAt,
      features,
    })
  }

  const regimeTag = await loadRegimeTagForDate(exitAt.slice(0, 10))
  if (regimeTag) {
    features = { ...features, regime_tag_at_exit: regimeTag }
  }
  features = applyAutoOutcomeLabels(features, params.pnl_pct, params.status)

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
    entryAt: params.entry_at,
  })

  try {
    await query(
      `INSERT INTO strategy_outcomes (
         strategy_id, domain, token_address, entry_at, exit_at,
         pnl_pct, status, is_simulated, features
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        params.strategy_id,
        params.domain,
        params.token_address,
        params.entry_at ?? null,
        exitAt,
        params.pnl_pct ?? null,
        params.status ?? null,
        params.is_simulated ?? true,
        JSON.stringify(features),
      ],
    )
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return
    }
    console.warn('[strategies/db] outcome insert failed:', errorMessage(error))
  }
}

export async function listStrategyOutcomes(params: {
  strategyId?: string
  domain?: StrategyDomain
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
  limit?: number
  offset?: number
}): Promise<{ rows: StrategyOutcomeRow[]; total: number }> {
  const limit = params.limit ?? 50
  const offset = params.offset ?? 0

  const { sql: whereSql, values } = buildOutcomeWhereClause(params)

  let rows: StrategyOutcomeRow[]
  try {
    const result = await query<Record<string, unknown>>(
      `SELECT * FROM strategy_outcomes
       ${whereSql}
       ORDER BY created_at DESC`,
      values,
    )
    rows = result.rows.map(mapStrategyOutcomeRow)
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
  const total = deduped.length
  const page = deduped.slice(offset, offset + limit)
  const enriched = await enrichOutcomeSymbols(page)
  return { rows: enriched, total }
}

/** All closed outcomes for ML dataset stats (no pagination). */
export async function loadOutcomesForMlDataset(params?: {
  domain?: StrategyDomain
  strategyId?: string
}): Promise<StrategyOutcomeRow[]> {
  const { sql: whereSql, values } = buildOutcomeWhereClause({
    domain: params?.domain,
    strategyId: params?.strategyId,
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

export async function backfillOutcomeLabels(params?: {
  domain?: StrategyDomain
  strategyId?: string
  dryRun?: boolean
}): Promise<{
  updated: number
  skipped_manual: number
  preview: Record<'0' | '1' | '2' | '3' | '4' | 'null', number>
}> {
  const rows = await loadOutcomesForMlDataset({
    domain: params?.domain,
    strategyId: params?.strategyId,
  })

  const preview: Record<'0' | '1' | '2' | '3' | '4' | 'null', number> = {
    '0': 0,
    '1': 0,
    '2': 0,
    '3': 0,
    '4': 0,
    null: 0,
  }
  let updated = 0
  let skippedManual = 0

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

    try {
      await query(
        `UPDATE strategy_outcomes SET features = $2 WHERE id = $1`,
        [row.id, JSON.stringify(nextFeatures)],
      )
      updated += 1
    } catch (error) {
      console.warn(
        '[strategies/db] backfillOutcomeLabels update failed:',
        errorMessage(error),
      )
    }
  }

  return { updated, skipped_manual: skippedManual, preview }
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
  const wins = pnls.filter((p) => p >= 0).length
  return {
    trade_count: rows.length,
    win_count: wins,
    win_rate: rows.length ? wins / rows.length : 0,
    avg_pnl_pct: pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0,
  }
}

export async function buildOpenMcapSimReportPositions(): Promise<McapOpenSimReportRow[]> {
  const mcapSimWallet =
    process.env.MCAP_TRACKER_SIM_WALLET_ADDRESS || 'mcap-tracker-sim'
  const [defRows, records] = await Promise.all([
    loadStrategyDefinitionRows('mcap_tracker'),
    fetchTradingRecordsForWallet(mcapSimWallet),
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
    open_sim_positions: await buildOpenMcapSimReportPositions(),
  }
}

export async function aggregateStrategyReports(params: {
  domain?: StrategyDomain
  strategyId?: string
  isSimulated?: boolean
  from?: string
  to?: string
}): Promise<{
  breakdown: StrategyReportBreakdown[]
  abPairs: import('./types').StrategyAbPair[]
  topTrades: StrategyOutcomeRow[]
  worstTrades: StrategyOutcomeRow[]
  coverage: StrategyCoverageRow[]
  mlStats: MlLabelStats
  mcapTrackerStats: McapTrackerReportStats
}> {
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
      `SELECT * FROM strategy_outcomes ${whereSql}`,
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
    const wins = pnls.filter((p: number) => p >= 0).length
    const losses = pnls.filter((p: number) => p < 0).length
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

  const defRows = await loadStrategyDefinitionRows()
  const breakdownByKey = new Map(
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
  const mcapSimWallet =
    process.env.MCAP_TRACKER_SIM_WALLET_ADDRESS || 'mcap-tracker-sim'
  const mcapSimRecords = await fetchTradingRecordsForWallet(mcapSimWallet)
  for (const def of defRows) {
    if (def.domain !== 'mcap_tracker') continue
    mcapOpenByStrategy.set(
      def.id,
      countOpenMcapSimPositions(mcapSimRecords, def.id),
    )
  }

  const coverage: StrategyCoverageRow[] = defRows.map((def) => {
    const sim = breakdown.find(
      (b) => b.strategy_id === def.id && b.domain === def.domain && b.is_simulated,
    )
    const live = breakdown.find(
      (b) => b.strategy_id === def.id && b.domain === def.domain && !b.is_simulated,
    )
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
    const domain = defRows.find((d) => d.id === id)?.domain ?? 'trending_bot'
    const sim = breakdown.find(
      (b) => b.strategy_id === id && b.is_simulated && b.domain === domain,
    ) ?? null
    const live = breakdown.find(
      (b) => b.strategy_id === id && !b.is_simulated && b.domain === domain,
    ) ?? null
    return { strategy_id: id, domain: domain as StrategyDomain, sim, live }
  })

  const withPnl = rows.filter((r) => r.pnl_pct != null)
  const topTrades = [...withPnl]
    .sort((a, b) => Number(b.pnl_pct) - Number(a.pnl_pct))
    .slice(0, 5)
  const worstTrades = [...withPnl]
    .sort((a, b) => Number(a.pnl_pct) - Number(b.pnl_pct))
    .slice(0, 5)

  const mlStats = computeMlLabelStats(rows)
  const mcapTrackerStats = await buildMcapTrackerReportStats(rows, breakdown)

  return { breakdown, abPairs, topTrades, worstTrades, coverage, mlStats, mcapTrackerStats }
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
  const domains: StrategyDomain[] = ['signals', 'trending_bot', 'dlmm', 'mcap_tracker', 'gmgn']
  const results: StrategyDomainHeartbeat[] = []
  const workerById = params?.workerLastSuccessById ?? {}

  const domainPrimaryWorkers: Record<StrategyDomain, string[]> = {
    mcap_tracker: ['mcap_tracker_sim_open', 'mcap_tracker_sim_track'],
    signals: ['signals_sim_track', 'signals_refresh'],
    trending_bot: ['trending_tracker'],
    dlmm: ['dlmm_manage'],
    gmgn: ['gmgn_sim_track', 'gmgn_activity_poll'],
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

export async function fetchTradingRecordsForWallet(
  walletAddress: string,
): Promise<import('@/utils/trading-tracker').TrackingRecord[]> {
  try {
    const { rows } = await query<{ data: import('@/utils/trading-tracker').TrackingRecord }>(
      `SELECT data FROM trading_records
       WHERE wallet_address = $1
       ORDER BY timestamp ASC`,
      [walletAddress],
    )
    return rows.map((r) =>
      typeof r.data === 'string'
        ? (JSON.parse(r.data) as import('@/utils/trading-tracker').TrackingRecord)
        : r.data,
    )
  } catch (error) {
    console.warn('[strategies/db] trading_records fetch failed:', errorMessage(error))
    return []
  }
}

/** @deprecated use Record<string, unknown> config in upsert */
export type { TrendingBotStrategyOverride }
