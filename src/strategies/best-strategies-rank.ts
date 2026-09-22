/**
 * Researchy room lock (honor exactly):
 * 1. Rank primary: avg pnl% × n + win%
 * 2. sum% is footnote only (never a rank key)
 * 3. Min-n floors — below floor cannot win top slots:
 *    - all-time n ≥ 30
 *    - 7d window n ≥ 10
 *    Below floor → omit from ranked list, or list under hypothesis / low-n only.
 */

import type { StrategyDomain, StrategyReportBreakdown } from './types'

/** Researchy floors — tiny-n strategies never win ranked / Telegram top slots. */
export const RESEARCHY_MIN_N_ALL_TIME = 30
export const RESEARCHY_MIN_N_7D = 10

export const DEFAULT_BEST_STRATEGIES_TOP_N = 5

export type BestStrategyRankRow = {
  strategy_id: string
  domain: StrategyDomain
  name: string
  is_simulated: boolean
  n: number
  all_time_n: number
  week_n: number
  avg_pnl_pct: number
  win_pct: number
  /** Primary rank key only: avg_pnl_pct × n + win_pct */
  score: number
  /** Footnote only — never used to order ranked slots. */
  sum_pnl_pct: number
  /** Below Researchy floor (hypothesis / low-n). */
  hypothesis: boolean
}

export type BestStrategiesBoard = {
  /** Passed Researchy min-n; ordered by avg×n+win% only. */
  ranked: BestStrategyRankRow[]
  /** Below floor — footnote / low-n only; never top slots. */
  hypothesis: BestStrategyRankRow[]
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

function toRankRow(
  b: StrategyReportBreakdown,
  names: Record<string, string> | undefined,
  allTimeN: number,
  weekN: number,
): BestStrategyRankRow {
  const winPct = b.win_rate * 100
  const n = b.trade_count
  const nameKey = `${b.domain}|${b.strategy_id}`
  const hypothesis = !qualifiesResearchyMinN(allTimeN, weekN)
  return {
    strategy_id: b.strategy_id,
    domain: b.domain,
    name:
      names?.[nameKey] ?? names?.[b.strategy_id] ?? b.strategy_id,
    is_simulated: b.is_simulated,
    n,
    all_time_n: allTimeN,
    week_n: weekN,
    avg_pnl_pct: b.avg_pnl_pct,
    win_pct: winPct,
    score: bestStrategyCompositeScore(b.avg_pnl_pct, n, winPct),
    sum_pnl_pct: b.total_pnl_pct,
    hypothesis,
  }
}

/** Sort by locked primary only; stable id for ties. sum% is never a sort key. */
function sortByLockedPrimary(a: BestStrategyRankRow, b: BestStrategyRankRow): number {
  if (a.score !== b.score) return b.score - a.score
  return a.strategy_id.localeCompare(b.strategy_id)
}

/**
 * Build ranked + hypothesis boards from all-time and 7d breakdowns.
 * Tiny-n (e.g. Sell-over-100 with small n) never enter `ranked`.
 */
export function qualifyBestStrategies(params: {
  allTime: StrategyReportBreakdown[]
  week: StrategyReportBreakdown[]
  topN?: number
  names?: Record<string, string>
  domains?: StrategyDomain[]
}): BestStrategiesBoard {
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
        // Prefer all-time for score inputs; fill from week only if no all-time yet.
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

  const ranked: BestStrategyRankRow[] = []
  const hypothesis: BestStrategyRankRow[] = []

  for (const agg of byKey.values()) {
    const n = agg.allTimeN > 0 ? agg.allTimeN : agg.weekN
    const breakdown: StrategyReportBreakdown = {
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
    }
    const row = toRankRow(
      breakdown,
      params.names,
      agg.allTimeN,
      agg.weekN,
    )
    if (row.hypothesis) {
      hypothesis.push(row)
    } else {
      ranked.push(row)
    }
  }

  ranked.sort(sortByLockedPrimary)
  hypothesis.sort(sortByLockedPrimary)

  return {
    ranked: ranked.slice(0, topN),
    hypothesis,
  }
}

/** Ranked strategy_ids only (Telegram blast gate). Hypothesis never included. */
export function rankedBestStrategyIds(board: BestStrategiesBoard): string[] {
  return [...new Set(board.ranked.map((r) => r.strategy_id))]
}
