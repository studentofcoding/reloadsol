import { supabase } from '@/utils/supabase'
import { getTrackingHealthStats } from '@/utils/mcap-tracker'
import { countOpenMcapSimPositions } from '@/utils/mcap-sim-track'
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
  McapTrackerReportStats,
} from './types'

export async function loadStrategyDefinitionRows(
  domain?: StrategyDomain,
): Promise<StrategyDefinitionRow[]> {
  let query = supabase.from('strategy_definitions').select('*')
  if (domain) {
    query = query.eq('domain', domain)
  }

  const { data, error } = await query

  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      return []
    }
    console.warn('[strategies/db] load failed:', error.message)
    return []
  }

  return (data ?? []) as StrategyDefinitionRow[]
}

export async function loadStrategyDefinitionById(
  id: string,
): Promise<StrategyDefinitionRow | null> {
  const { data, error } = await supabase
    .from('strategy_definitions')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      return null
    }
    console.warn('[strategies/db] load by id failed:', error.message)
    return null
  }

  return (data as StrategyDefinitionRow) ?? null
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
  const row: Record<string, unknown> = {
    id: params.id,
    domain: params.domain,
    name: params.name,
    description: params.description ?? null,
    config: params.config,
    is_active: params.is_active,
    updated_at: new Date().toISOString(),
  }
  if (params.execution_mode) {
    row.execution_mode = params.execution_mode
  }

  const { error } = await supabase.from('strategy_definitions').upsert(row, {
    onConflict: 'id',
  })

  if (error) {
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

export { dedupeStrategyOutcomeRows, mcapSimClosedOutcomeKey } from './outcome-dedupe'

export async function loadMcapSimClosedOutcomeKeys(
  strategyId: string,
  tokenAddresses: string[],
): Promise<Set<string>> {
  if (tokenAddresses.length === 0) return new Set()

  const { data, error } = await supabase
    .from('strategy_outcomes')
    .select('token_address, entry_at')
    .eq('strategy_id', strategyId)
    .eq('domain', 'mcap_tracker')
    .in('token_address', tokenAddresses)

  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      return new Set()
    }
    console.warn(
      '[strategies/db] loadMcapSimClosedOutcomeKeys failed:',
      error.message,
    )
    return new Set()
  }

  const keys = new Set<string>()
  for (const row of data ?? []) {
    if (row.token_address && row.entry_at) {
      keys.add(mcapSimClosedOutcomeKey(row.token_address, row.entry_at))
    }
  }
  return keys
}

export async function loadRegimeTagForDate(tagDate: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('market_regime_tags')
    .select('regime_tag')
    .eq('tag_date', tagDate)
    .maybeSingle()

  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      return null
    }
    console.warn('[strategies/db] loadRegimeTagForDate failed:', error.message)
    return null
  }

  return typeof data?.regime_tag === 'string' ? data.regime_tag : null
}

export async function upsertMarketRegimeTag(params: {
  tagDate: string
  regimeTag: string
  notes?: string | null
}): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase.from('market_regime_tags').upsert(
    {
      tag_date: params.tagDate,
      regime_tag: params.regimeTag,
      notes: params.notes ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'tag_date' },
  )

  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      return { ok: false, error: 'market_regime_tags table missing' }
    }
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

export async function listMarketRegimeTags(limit = 30): Promise<
  Array<{ tag_date: string; regime_tag: string; notes: string | null }>
> {
  const { data, error } = await supabase
    .from('market_regime_tags')
    .select('tag_date, regime_tag, notes')
    .order('tag_date', { ascending: false })
    .limit(limit)

  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      return []
    }
    console.warn('[strategies/db] listMarketRegimeTags failed:', error.message)
    return []
  }

  return (data ?? []) as Array<{
    tag_date: string
    regime_tag: string
    notes: string | null
  }>
}

async function strategyOutcomeExists(params: {
  strategy_id: string
  domain: StrategyDomain
  token_address: string
  entry_at: string
}): Promise<boolean> {
  const { data, error } = await supabase
    .from('strategy_outcomes')
    .select('id')
    .eq('strategy_id', params.strategy_id)
    .eq('domain', params.domain)
    .eq('token_address', params.token_address)
    .eq('entry_at', params.entry_at)
    .limit(1)
    .maybeSingle()

  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      return false
    }
    console.warn('[strategies/db] strategyOutcomeExists failed:', error.message)
    return false
  }

  return !!data
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

  const { error } = await supabase.from('strategy_outcomes').insert({
    strategy_id: params.strategy_id,
    domain: params.domain,
    token_address: params.token_address,
    entry_at: params.entry_at ?? null,
    exit_at: exitAt,
    pnl_pct: params.pnl_pct ?? null,
    status: params.status ?? null,
    is_simulated: params.is_simulated ?? true,
    features,
  })

  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      return
    }
    console.warn('[strategies/db] outcome insert failed:', error.message)
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
  trainingClassOnly?: boolean
  trainingClassMin?: number
  recomputeLabels?: boolean
  limit?: number
  offset?: number
}): Promise<{ rows: StrategyOutcomeRow[]; total: number }> {
  const limit = params.limit ?? 50
  const offset = params.offset ?? 0

  let query = supabase
    .from('strategy_outcomes')
    .select('*')
    .order('created_at', { ascending: false })

  if (params.strategyId) {
    query = query.eq('strategy_id', params.strategyId)
  }
  if (params.domain) {
    query = query.eq('domain', params.domain)
  }
  if (params.isSimulated !== undefined) {
    query = query.eq('is_simulated', params.isSimulated)
  }
  if (params.from) {
    query = query.gte('exit_at', params.from)
  }
  if (params.to) {
    query = query.lte('exit_at', params.to)
  }
  if (params.mlLabel === 'unlabeled') {
    query = query.or('features->>ml_label.is.null,features->>ml_label.eq.')
  } else if (params.mlLabel) {
    query = query.eq('features->>ml_label', params.mlLabel)
  }
  if (params.mlCondition === 'none') {
    query = query.or('features->>ml_condition.is.null,features->>ml_condition.eq.')
  } else if (params.mlCondition) {
    query = query.eq('features->>ml_condition', params.mlCondition)
  }
  if (params.status) {
    query = query.eq('status', params.status)
  }
  if (params.pnlMin !== undefined) {
    query = query.gte('pnl_pct', params.pnlMin)
  }
  if (params.pnlMax !== undefined) {
    query = query.lte('pnl_pct', params.pnlMax)
  }
  if (params.entryMcapBand) {
    query = query.eq('features->>entry_mcap_band', params.entryMcapBand)
  }

  const { data, error } = await query

  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      return { rows: [], total: 0 }
    }
    throw error
  }

  let deduped = dedupeStrategyOutcomeRows((data ?? []) as StrategyOutcomeRow[])
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
  const rows = await enrichOutcomeSymbols(page)
  return { rows, total }
}

/** All closed outcomes for ML dataset stats (no pagination). */
export async function loadOutcomesForMlDataset(params?: {
  domain?: StrategyDomain
  strategyId?: string
}): Promise<StrategyOutcomeRow[]> {
  let query = supabase.from('strategy_outcomes').select('*')

  if (params?.domain) query = query.eq('domain', params.domain)
  if (params?.strategyId) query = query.eq('strategy_id', params.strategyId)

  const { data, error } = await query

  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      return []
    }
    throw error
  }

  const deduped = dedupeStrategyOutcomeRows((data ?? []) as StrategyOutcomeRow[])
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

    const { error } = await supabase
      .from('strategy_outcomes')
      .update({ features: nextFeatures })
      .eq('id', row.id)

    if (error) {
      console.warn('[strategies/db] backfillOutcomeLabels update failed:', error.message)
      continue
    }
    updated += 1
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
  const trackerTable =
    process.env.NODE_ENV === 'development'
      ? 'trending_token_tracker_dev'
      : 'trending_token_tracker'

  const [trackerRes, signalsRes, mcapRes] = await Promise.all([
    supabase
      .from(trackerTable)
      .select('token_address, token_symbol')
      .in('token_address', addresses),
    supabase
      .from('trading_signals')
      .select('token_address, token_symbol')
      .in('token_address', addresses),
    supabase
      .from('token_mcap_tracking')
      .select('token_address, token_symbol')
      .in('token_address', addresses),
  ])

  const symbolMap = new Map<string, string>()
  for (const row of trackerRes.data ?? []) {
    if (row.token_symbol) symbolMap.set(row.token_address, row.token_symbol)
  }
  for (const row of signalsRes.data ?? []) {
    if (row.token_symbol && !symbolMap.has(row.token_address)) {
      symbolMap.set(row.token_address, row.token_symbol)
    }
  }
  for (const row of mcapRes.data ?? []) {
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
  const { data, error } = await supabase
    .from('strategy_outcomes')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      return null
    }
    throw error
  }

  return (data as StrategyOutcomeRow) ?? null
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

  const { data, error } = await supabase
    .from('strategy_outcomes')
    .update({ features: mergedFeatures })
    .eq('id', id)
    .select('*')
    .single()

  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      return { ok: false, error: 'Outcomes table unavailable' }
    }
    return { ok: false, error: error.message }
  }

  return { ok: true, row: data as StrategyOutcomeRow }
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
  let query = supabase.from('strategy_outcomes').select('*')

  if (params.strategyId) query = query.eq('strategy_id', params.strategyId)
  if (params.domain) query = query.eq('domain', params.domain)
  if (params.isSimulated !== undefined) query = query.eq('is_simulated', params.isSimulated)
  if (params.from) query = query.gte('exit_at', params.from)
  if (params.to) query = query.lte('exit_at', params.to)

  const { data, error } = await query

  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      return {
        breakdown: [],
        abPairs: [],
        topTrades: [],
        worstTrades: [],
        coverage: [],
        mlStats: { total: 0, unlabeled: 0, by_label: {}, by_condition: {} },
        mcapTrackerStats: {
          strategies: [],
          milestone_buckets: [],
          timeline_inconsistent_count: 0,
          total_tracked_tokens: 0,
        },
      }
    }
    throw error
  }

  const rows = dedupeStrategyOutcomeRows((data ?? []) as StrategyOutcomeRow[])
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
  const trackerTable =
    process.env.NODE_ENV === 'development'
      ? 'trending_token_tracker_dev'
      : 'trending_token_tracker'
  const { data: trackerRows } = await supabase
    .from(trackerTable)
    .select('status, trading_simulation')
    .eq('status', 'tracking')
  for (const row of trackerRows ?? []) {
    if (!isOpenTrackerPosition(row)) continue
    const sid = resolveTrackerStrategyId(
      row.trading_simulation as Record<string, unknown> | null | undefined,
    )
    if (!sid) continue
    openByStrategy.set(sid, (openByStrategy.get(sid) ?? 0) + 1)
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

export async function getStrategyDomainHeartbeats(): Promise<
  Array<{ domain: StrategyDomain; last_outcome_at: string | null }>
> {
  const domains: StrategyDomain[] = ['signals', 'trending_bot', 'dlmm', 'mcap_tracker']
  const results: Array<{ domain: StrategyDomain; last_outcome_at: string | null }> = []

  for (const domain of domains) {
    const { data, error } = await supabase
      .from('strategy_outcomes')
      .select('exit_at, created_at')
      .eq('domain', domain)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      if (error.code === '42P01' || error.message?.includes('does not exist')) {
        results.push({ domain, last_outcome_at: null })
        continue
      }
      console.warn('[strategies/db] domain heartbeat failed:', error.message)
      results.push({ domain, last_outcome_at: null })
      continue
    }

    const row = data as { exit_at?: string | null; created_at?: string | null } | null
    results.push({
      domain,
      last_outcome_at: row?.exit_at ?? row?.created_at ?? null,
    })
  }

  return results
}

export async function fetchTradingRecordsForWallet(
  walletAddress: string,
): Promise<import('@/utils/trading-tracker').TrackingRecord[]> {
  const { data, error } = await supabase
    .from('trading_records')
    .select('data')
    .eq('wallet_address', walletAddress)
    .order('timestamp', { ascending: true })

  if (error) {
    console.warn('[strategies/db] trading_records fetch failed:', error.message)
    return []
  }

  return (data ?? []).map((r) => r.data as import('@/utils/trading-tracker').TrackingRecord)
}

/** @deprecated use Record<string, unknown> config in upsert */
export type { TrendingBotStrategyOverride }
