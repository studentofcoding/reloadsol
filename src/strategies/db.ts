import { supabase } from '@/utils/supabase'
import type {
  StrategyDefinitionRow,
  StrategyDomain,
  StrategyOutcomeRow,
  StrategyReportBreakdown,
  StrategyCoverageRow,
  TrendingBotStrategyOverride,
  ExecutionMode,
  OutcomeChartSource,
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
  const { error } = await supabase.from('strategy_outcomes').insert({
    strategy_id: params.strategy_id,
    domain: params.domain,
    token_address: params.token_address,
    entry_at: params.entry_at ?? null,
    exit_at: params.exit_at ?? new Date().toISOString(),
    pnl_pct: params.pnl_pct ?? null,
    status: params.status ?? null,
    is_simulated: params.is_simulated ?? true,
    features: params.features ?? null,
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
  limit?: number
  offset?: number
}): Promise<{ rows: StrategyOutcomeRow[]; total: number }> {
  const limit = params.limit ?? 50
  const offset = params.offset ?? 0

  let query = supabase
    .from('strategy_outcomes')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

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

  const { data, error, count } = await query

  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      return { rows: [], total: 0 }
    }
    throw error
  }

  return { rows: (data ?? []) as StrategyOutcomeRow[], total: count ?? 0 }
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

const TRACKER_TABLE =
  process.env.NODE_ENV === 'development'
    ? 'trending_token_tracker_dev'
    : 'trending_token_tracker'

type PriceHistoryPoint = { timestamp: string; price_usd: number }

function parsePriceHistory(raw: unknown): PriceHistoryPoint[] {
  if (!raw) return []
  let data = raw
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      return []
    }
  }
  if (!Array.isArray(data)) return []
  return data
    .filter(
      (p): p is PriceHistoryPoint =>
        p != null &&
        typeof p === 'object' &&
        typeof (p as PriceHistoryPoint).timestamp === 'string' &&
        typeof (p as PriceHistoryPoint).price_usd === 'number',
    )
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    )
}

function filterPointsToWindow(
  points: PriceHistoryPoint[],
  entryAt: string,
  exitAt: string,
): PriceHistoryPoint[] {
  const start = new Date(entryAt).getTime()
  const end = new Date(exitAt).getTime()
  if (Number.isNaN(start) || Number.isNaN(end)) return []
  return points.filter((p) => {
    const t = new Date(p.timestamp).getTime()
    return t >= start && t <= end
  })
}

export async function loadOutcomeTradeWindowChart(params: {
  outcome: StrategyOutcomeRow
}): Promise<{ points: PriceHistoryPoint[]; source: OutcomeChartSource }> {
  const { outcome } = params
  const entryAt = outcome.entry_at
  const exitAt = outcome.exit_at
  const tokenAddress = outcome.token_address

  if (!entryAt || !exitAt) {
    return { points: [], source: 'empty' }
  }

  if (tokenAddress) {
    const { data, error } = await supabase
      .from(TRACKER_TABLE)
      .select('price_history')
      .eq('token_address', tokenAddress)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!error && data?.price_history) {
      const filtered = filterPointsToWindow(
        parsePriceHistory(data.price_history),
        entryAt,
        exitAt,
      )
      if (filtered.length > 0) {
        return { points: filtered, source: 'tracker' }
      }
    }
  }

  const features = outcome.features ?? {}
  const initialPrice = features.initial_price_usd
  const exitPrice = features.exit_price_usd

  if (
    typeof initialPrice === 'number' &&
    typeof exitPrice === 'number' &&
    !Number.isNaN(initialPrice) &&
    !Number.isNaN(exitPrice)
  ) {
    return {
      points: [
        { timestamp: entryAt, price_usd: initialPrice },
        { timestamp: exitAt, price_usd: exitPrice },
      ],
      source: 'outcome_features',
    }
  }

  if (typeof exitPrice === 'number' && !Number.isNaN(exitPrice)) {
    return {
      points: [
        { timestamp: entryAt, price_usd: exitPrice },
        { timestamp: exitAt, price_usd: exitPrice },
      ],
      source: 'synthetic',
    }
  }

  return { points: [], source: 'empty' }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
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
      return { breakdown: [], abPairs: [], topTrades: [], worstTrades: [], coverage: [] }
    }
    throw error
  }

  const rows = (data ?? []) as StrategyOutcomeRow[]
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
    }
  })
  const abParallelIds = defRows
    .filter((d) => d.execution_mode === 'ab_parallel')
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

  return { breakdown, abPairs, topTrades, worstTrades, coverage }
}

export async function getStrategyDomainHeartbeats(): Promise<
  Array<{ domain: StrategyDomain; last_outcome_at: string | null }>
> {
  const domains: StrategyDomain[] = ['signals', 'trending_bot', 'dlmm']
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
