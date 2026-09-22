/**
 * Locked best-strategies ranking: avg pnl% × n + win% (sum% secondary).
 * Researchy min-n floors gate which keys may count as “best” emitters.
 */

import type { StrategyDomain, StrategyReportBreakdown } from './types'

/** Researchy floors — tiny-n strategies never qualify as best emitters. */
export const RESEARCHY_MIN_N_ALL_TIME = 30
export const RESEARCHY_MIN_N_7D = 10

export const DEFAULT_BEST_STRATEGIES_TOP_N = 5

export type BestStrategyRankRow = {
  strategy_id: string
  domain: StrategyDomain
  name: string
  is_simulated: boolean
  n: number
  avg_pnl_pct: number
  win_pct: number
  /** Primary rank key: avg_pnl_pct × n + win_pct */
  score: number
  /** Secondary tie-break: sum of pnl% */
  sum_pnl_pct: number
  /** True when sample is below Researchy all-time floor (still may pass via 7d). */
  thin_all_time: boolean
}

/** Locked primary score: avg pnl% × n + win%. */
export function bestStrategyCompositeScore(
  avgPnlPct: number,
  n: number,
  winPct: number,
): number {
  return avgPnlPct * n + winPct
}

/** Passes Researchy min-n: all-time n≥30 OR 7d n≥10. */
export function qualifiesResearchyMinN(
  allTimeN: number,
  weekN: number,
): boolean {
  return (
    allTimeN >= RESEARCHY_MIN_N_ALL_TIME || weekN >= RESEARCHY_MIN_N_7D
  )
}

export function rankBestStrategies(
  breakdown: StrategyReportBreakdown[],
  options?: {
    topN?: number
    names?: Record<string, string>
    domains?: StrategyDomain[]
    minN?: number
  },
): BestStrategyRankRow[] {
  const topN = options?.topN ?? DEFAULT_BEST_STRATEGIES_TOP_N
  const domainFilter = options?.domains ? new Set(options.domains) : null
  const minN = options?.minN ?? 1

  const rows: BestStrategyRankRow[] = []
  for (const b of breakdown) {
    if (b.trade_count < minN) continue
    if (domainFilter && !domainFilter.has(b.domain)) continue
    const winPct = b.win_rate * 100
    const score = bestStrategyCompositeScore(
      b.avg_pnl_pct,
      b.trade_count,
      winPct,
    )
    const nameKey = `${b.domain}|${b.strategy_id}`
    rows.push({
      strategy_id: b.strategy_id,
      domain: b.domain,
      name:
        options?.names?.[nameKey] ??
        options?.names?.[b.strategy_id] ??
        b.strategy_id,
      is_simulated: b.is_simulated,
      n: b.trade_count,
      avg_pnl_pct: b.avg_pnl_pct,
      win_pct: winPct,
      score,
      sum_pnl_pct: b.total_pnl_pct,
      thin_all_time: b.trade_count < RESEARCHY_MIN_N_ALL_TIME,
    })
  }

  rows.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    if (a.sum_pnl_pct !== b.sum_pnl_pct) return b.sum_pnl_pct - a.sum_pnl_pct
    return a.strategy_id.localeCompare(b.strategy_id)
  })

  return rows.slice(0, topN)
}

/**
 * Merge all-time + 7d buckets: keep strategies that pass Researchy min-n,
 * score with all-time stats when available else 7d, then take top N.
 */
export function qualifyBestStrategies(params: {
  allTime: StrategyReportBreakdown[]
  week: StrategyReportBreakdown[]
  topN?: number
  names?: Record<string, string>
  domains?: StrategyDomain[]
}): BestStrategyRankRow[] {
  const topN = params.topN ?? DEFAULT_BEST_STRATEGIES_TOP_N
  const domainFilter = params.domains ? new Set(params.domains) : null

  type Agg = {
    domain: StrategyDomain
    strategy_id: string
    is_simulated: boolean
    allTimeN: number
    weekN: number
    avg_pnl_pct: number
    win_rate: number
    total_pnl_pct: number
  }

  const byKey = new Map<string, Agg>()

  const ingest = (
    rows: StrategyReportBreakdown[],
    which: 'all' | 'week',
  ) => {
    for (const b of rows) {
      if (b.trade_count <= 0) continue
      if (domainFilter && !domainFilter.has(b.domain)) continue
      const key = `${b.domain}|${b.strategy_id}|${b.is_simulated}`
      const cur = byKey.get(key) ?? {
        domain: b.domain,
        strategy_id: b.strategy_id,
        is_simulated: b.is_simulated,
        allTimeN: 0,
        weekN: 0,
        avg_pnl_pct: 0,
        win_rate: 0,
        total_pnl_pct: 0,
      }
      if (which === 'all') {
        cur.allTimeN = b.trade_count
        cur.avg_pnl_pct = b.avg_pnl_pct
        cur.win_rate = b.win_rate
        cur.total_pnl_pct = b.total_pnl_pct
      } else {
        cur.weekN = b.trade_count
        // Prefer all-time for score; fill from week only if no all-time yet.
        if (cur.allTimeN === 0) {
          cur.avg_pnl_pct = b.avg_pnl_pct
          cur.win_rate = b.win_rate
          cur.total_pnl_pct = b.total_pnl_pct
        }
      }
      byKey.set(key, cur)
    }
  }

  ingest(params.allTime, 'all')
  ingest(params.week, 'week')

  const eligible: StrategyReportBreakdown[] = []
  for (const agg of byKey.values()) {
    if (!qualifiesResearchyMinN(agg.allTimeN, agg.weekN)) continue
    const n = agg.allTimeN > 0 ? agg.allTimeN : agg.weekN
    eligible.push({
      strategy_id: agg.strategy_id,
      domain: agg.domain,
      is_simulated: agg.is_simulated,
      trade_count: n,
      win_count: Math.round(agg.win_rate * n),
      loss_count: n - Math.round(agg.win_rate * n),
      win_rate: agg.win_rate,
      avg_pnl_pct: agg.avg_pnl_pct,
      median_pnl_pct: agg.avg_pnl_pct,
      total_pnl_pct: agg.total_pnl_pct,
      last_exit_at: null,
    })
  }

  return rankBestStrategies(eligible, {
    topN,
    names: params.names,
    minN: 1,
  })
}
