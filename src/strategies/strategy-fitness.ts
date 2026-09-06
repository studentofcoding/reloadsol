/**
 * The one definition of a "winning" strategy, shared by the bandit kill rule,
 * offline search ranking, the promote gate and the admin hub.
 *
 * Winner = positive expectancy per trade over a rolling window with enough
 * closes AND no drawdown week (≥ minWeekLosses losses and week PnL ≤ maxWeekLossPct).
 */
import { isoWeekKey } from './strategy-review'

export type FitnessConfig = {
  windowDays: number
  minCloses: number
  /** A week with total PnL at or below this (e.g. -40) … */
  maxWeekLossPct: number
  /** … and at least this many losses counts as a drawdown week. */
  minWeekLosses: number
}

export const DEFAULT_FITNESS: FitnessConfig = {
  windowDays: 28,
  minCloses: 20,
  maxWeekLossPct: -40,
  minWeekLosses: 3,
}

export type FitnessOutcome = {
  pnl_pct: number | null
  exit_at: string | null
  created_at?: string | null
}

export type StrategyFitness = {
  closes: number
  expectancyPct: number
  winRate: number
  totalPnlPct: number
  worstWeekPnlPct: number | null
  drawdownWeeks: string[]
  passes: boolean
  reasons: string[]
}

export function computeStrategyFitness(
  outcomes: readonly FitnessOutcome[],
  cfg: Partial<FitnessConfig> = {},
  now: Date = new Date(),
): StrategyFitness {
  const c = { ...DEFAULT_FITNESS, ...cfg }
  const since = now.getTime() - c.windowDays * 86_400_000
  const rows = outcomes.filter((o) => {
    const at = o.exit_at ?? o.created_at
    const t = at ? Date.parse(at) : NaN
    return Number.isFinite(t) && t >= since && t <= now.getTime() && o.pnl_pct != null && Number.isFinite(o.pnl_pct)
  })

  const closes = rows.length
  const totalPnlPct = rows.reduce((a, r) => a + (r.pnl_pct as number), 0)
  const wins = rows.filter((r) => (r.pnl_pct as number) >= 0).length
  const expectancyPct = closes ? totalPnlPct / closes : 0
  const winRate = closes ? wins / closes : 0

  const weeks = new Map<string, { pnl: number; losses: number }>()
  for (const r of rows) {
    const wk = isoWeekKey((r.exit_at ?? r.created_at) as string)
    if (!wk) continue
    const w = weeks.get(wk) ?? { pnl: 0, losses: 0 }
    w.pnl += r.pnl_pct as number
    if ((r.pnl_pct as number) < 0) w.losses++
    weeks.set(wk, w)
  }
  const drawdownWeeks = [...weeks.entries()]
    .filter(([, w]) => w.losses >= c.minWeekLosses && w.pnl <= c.maxWeekLossPct)
    .map(([k]) => k)
    .sort()
  const worstWeekPnlPct = weeks.size ? Math.min(...[...weeks.values()].map((w) => w.pnl)) : null

  const reasons: string[] = []
  if (closes < c.minCloses) reasons.push(`closes ${closes} < ${c.minCloses}`)
  if (expectancyPct <= 0) reasons.push(`expectancy ${expectancyPct.toFixed(2)}% ≤ 0`)
  if (drawdownWeeks.length > 0) reasons.push(`drawdown week(s): ${drawdownWeeks.join(', ')}`)

  return {
    closes,
    expectancyPct: round2(expectancyPct),
    winRate: round2(winRate),
    totalPnlPct: round2(totalPnlPct),
    worstWeekPnlPct: worstWeekPnlPct == null ? null : round2(worstWeekPnlPct),
    drawdownWeeks,
    passes: reasons.length === 0,
    reasons,
  }
}

/** Fitness per strategy_id from a mixed outcome list. */
export function computeFitnessByStrategy<T extends FitnessOutcome & { strategy_id: string }>(
  outcomes: readonly T[],
  cfg?: Partial<FitnessConfig>,
  now?: Date,
): Map<string, StrategyFitness> {
  const groups = new Map<string, T[]>()
  for (const o of outcomes) {
    const g = groups.get(o.strategy_id) ?? []
    g.push(o)
    groups.set(o.strategy_id, g)
  }
  return new Map([...groups].map(([id, rows]) => [id, computeStrategyFitness(rows, cfg, now)]))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
