/**
 * Daily PnL progress for the paper system, reported in SOL against a daily budget.
 *
 * Two reporting knobs only — they describe how to *present* PnL, they are not a sizing system:
 *   SIM_DAILY_BUDGET_SOL    (0.5)   capital available per day, a concurrency limit
 *   SIM_BASE_POSITION_SOL   (0.005) the base stake a position is sized from
 *
 * Sizing itself is whatever the system already applied, and the outcomes record it: `ml_size_mult`
 * (stamped by `ml-soft-size.ts`, the base × mult pipeline) is present on ~599 of ~750 recent closes
 * and is the only sizing key actually written today. So every SOL figure here is computed twice —
 * once at the flat base stake, once weighted by the multiplier the system chose — and the difference
 * is the sizing's effect, shown rather than assumed.
 *
 * The brain's climate/regime (`Hype|Range|Mixed|De-risk|Cash`, with its own `sizeScale`) is the live
 * regime source, but it is *not* stamped on outcomes, so historical rows can't be grouped by it.
 * `market_regime_tags` is a separate vocabulary that stopped in July and is on no recent close; it is
 * carried as an informational label only.
 *
 * The budget is a concurrency constraint, not a turnover one: capital recycles, so the binding number
 * is `peak_concurrent × size`, and `capacity` is how many positions fit at once.
 */

export interface DailyPnlRow {
  day: string
  /** Informational only: from market_regime_tags, which is dormant. */
  regimeTag: string | null
  trades: number
  won: number
  lost: number
  sumPnlPct: number
  /** Σ pnl_pct × ml_size_mult — the percentage return as actually sized. */
  sumPnlPctWeighted: number
  avgPnlPct: number
  medianPnlPct: number
  /** Base stake × Σ pnl_pct / 100: what a flat 0.005 per position would have returned. */
  pnlSolFlat: number
  /** Base stake × Σ(pnl_pct × mult) / 100: what the system's own sizing returned. */
  pnlSolSized: number
  medianSizeMult: number | null
  /** Mean applied sizing, so the average stake is base × this. */
  meanSizeMult: number
  withSizeMult: number
  /** Closed-trade win rate for the day. */
  winRatePct: number
  /** Average stake at risk per position, in SOL. */
  avgRiskSol: number
  /** Average realized reward per winning trade, in SOL. */
  avgRewardSol: number
  /** avg win / |avg loss| — the realized reward:risk ratio. */
  winLossRatio: number | null
  /** gross wins / |gross losses|, null when the day had no losses. */
  profitFactor: number | null
  grossWinPct: number
  grossLossPct: number
  avgWinPct: number
  avgLossPct: number
  bestPnlPct: number
  worstPnlPct: number
  withExec: number
  execPnlSol: number | null
  peakConcurrent: number
  capitalSol: number
  budgetUsedPct: number
  capacity: number
  /** Capacity once the day's median multiplier is applied. */
  sizedCapacity: number
  /** Peak simultaneous capital — the most the budget was spending at one instant. */
  velocityMaxSol: number
  /** That peak as a share of the budget. */
  velocityMaxPct: number
  /** Smallest budget that would have covered this day, with headroom applied. */
  optimalBudgetSol: number
}

export interface SizingBucket {
  /** The stamped multiplier the bucket represents. */
  sizeMult: number
  trades: number
  won: number
  lost: number
  sumPnlPct: number
  pnlSolSized: number
}

export interface PnlBudgetSummary {
  budgetSol: number
  basePositionSizeSol: number
  capacity: number
  days: number
  trades: number
  won: number
  lost: number
  winRatePct: number
  sumPnlPct: number
  pnlSolFlat: number
  pnlSolSized: number
  sizingEffectPct: number
  pnlSolSizedPerDay: number
  tradesWithSizeMult: number
  medianSizeMult: number | null
  execPnlSol: number | null
  tradesWithExec: number
  peakConcurrent: number
  peakCapitalSol: number
  peakBudgetUsedPct: number
  bestDay: { day: string; pnlSol: number } | null
  worstDay: { day: string; pnlSol: number } | null
  avgWinPct: number
  avgLossPct: number
  avgRiskSol: number
  avgRewardSol: number
  winLossRatio: number | null
  profitFactor: number | null
  /** Peak simultaneous capital over the range (the binding number). */
  velocityMaxSol: number
  /** The largest day's optimal budget: what the daily budget should have been. */
  suggestedDailyBudgetSol: number
  budgetHeadroom: number
  /** Is the configured budget at least the suggested one? */
  budgetAdequate: boolean
}

function num(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function positiveNumber(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function resolveDailyBudgetSol(env: Record<string, string | undefined> = process.env): number {
  return positiveNumber(env.SIM_DAILY_BUDGET_SOL) ?? 0.5
}

export function resolveBasePositionSizeSol(
  env: Record<string, string | undefined> = process.env,
): number {
  return positiveNumber(env.SIM_BASE_POSITION_SOL) ?? 0.005
}

/** Headroom multiplier for the suggested budget: sizing at exactly the observed peak is brittle. */
export function resolveBudgetHeadroom(env: Record<string, string | undefined> = process.env): number {
  return positiveNumber(env.SIM_BUDGET_HEADROOM) ?? 1.25
}

/**
 * The families the dashboard's fold toggle removes: measured to lose on both the 7-day window and
 * the spine era, at every stake. See docs/diagrams/12-proposal-register.html (P3, gated by C-3 on
 * READINESS_MIN_SAMPLE plus a non-negative net per trade).
 *
 * This is a *selection* decision, not a sizing one — a fold is binary, and the register is explicit
 * that turning it into a weight is worse than either extreme. The list lives here rather than in the
 * client so the aggregate, the per-day drill-down, the ledger and the open-position list cannot
 * disagree about what "folded" means.
 */
export const DEFAULT_FOLDED_STRATEGY_IDS = [
  'gmgn_sm_kol_combined',
  'gmgn_kol_momentum',
  'social_only_fomo_gt7',
  'att_rh',
] as const

/**
 * Env-overridable so a re-check can widen or narrow the fold without a deploy. An explicitly empty
 * `SIM_FOLDED_STRATEGIES` folds nothing, which is how the toggle's "off" state is spelled server-side.
 */
export function resolveFoldedStrategyIds(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env.SIM_FOLDED_STRATEGIES
  if (raw == null) return [...DEFAULT_FOLDED_STRATEGY_IDS]
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
}

export function capacityForBudget(budgetSol: number, positionSizeSol: number): number {
  return positionSizeSol > 0 ? Math.floor(budgetSol / positionSizeSol) : 0
}

export function pnlSolFor(sumPnlPct: number, positionSizeSol: number): number {
  return (positionSizeSol * sumPnlPct) / 100
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export function buildDailyRows(params: {
  daily: Array<{
    day: string
    trades: number
    won: number
    lost: number
    sum_pnl_pct: string | number | null
    sum_pnl_pct_weighted?: string | number | null
    gross_win_pct?: string | number | null
    gross_loss_pct?: string | number | null
    avg_win_pct?: string | number | null
    avg_loss_pct?: string | number | null
    best_pnl_pct?: string | number | null
    worst_pnl_pct?: string | number | null
    mean_size_mult?: string | number | null
    median_size_mult?: string | number | null
    with_size_mult?: number
    avg_pnl_pct: string | number | null
    median_pnl_pct: string | number | null
    with_exec: number
    exec_pnl_quote: string | number | null
  }>
  peaks: Array<{ day: string; peak_open: string | number | null }>
  regimeByDay?: Map<string, string | null>
  basePositionSizeSol: number
  budgetSol: number
  budgetHeadroom?: number
}): DailyPnlRow[] {
  const peakByDay = new Map(params.peaks.map((p) => [p.day, num(p.peak_open)]))
  return params.daily.map((row) => {
    const sumPnlPct = num(row.sum_pnl_pct)
    const sumWeighted = num(row.sum_pnl_pct_weighted ?? row.sum_pnl_pct)
    const medianMult = row.median_size_mult == null ? null : num(row.median_size_mult)
    const peakConcurrent = peakByDay.get(row.day) ?? 0
    const capitalSol = peakConcurrent * params.basePositionSizeSol
    const mult = medianMult && medianMult > 0 ? medianMult : 1
    const meanMult = num(row.mean_size_mult) > 0 ? num(row.mean_size_mult) : 1
    const trades = num(row.trades)
    const won = num(row.won)
    const grossWinPct = num(row.gross_win_pct)
    const grossLossPct = num(row.gross_loss_pct)
    const avgWinPct = num(row.avg_win_pct)
    const avgLossPct = num(row.avg_loss_pct)
    const avgRiskSol = params.basePositionSizeSol * meanMult
    return {
      day: row.day,
      regimeTag: params.regimeByDay?.get(row.day) ?? null,
      trades: num(row.trades),
      won: num(row.won),
      lost: num(row.lost),
      sumPnlPct,
      sumPnlPctWeighted: sumWeighted,
      avgPnlPct: num(row.avg_pnl_pct),
      medianPnlPct: num(row.median_pnl_pct),
      pnlSolFlat: pnlSolFor(sumPnlPct, params.basePositionSizeSol),
      pnlSolSized: pnlSolFor(sumWeighted, params.basePositionSizeSol),
      medianSizeMult: medianMult,
      meanSizeMult: meanMult,
      withSizeMult: num(row.with_size_mult),
      winRatePct: trades > 0 ? (won / trades) * 100 : 0,
      avgRiskSol,
      avgRewardSol: avgRiskSol * (avgWinPct / 100),
      winLossRatio: avgLossPct < 0 ? avgWinPct / Math.abs(avgLossPct) : null,
      profitFactor: grossLossPct < 0 ? grossWinPct / Math.abs(grossLossPct) : null,
      grossWinPct,
      grossLossPct,
      avgWinPct,
      avgLossPct,
      bestPnlPct: num(row.best_pnl_pct),
      worstPnlPct: num(row.worst_pnl_pct),
      withExec: num(row.with_exec),
      execPnlSol: num(row.with_exec) > 0 ? num(row.exec_pnl_quote) : null,
      peakConcurrent,
      capitalSol,
      budgetUsedPct: params.budgetSol > 0 ? (capitalSol / params.budgetSol) * 100 : 0,
      capacity: capacityForBudget(params.budgetSol, params.basePositionSizeSol),
      velocityMaxSol: capitalSol,
      velocityMaxPct: params.budgetSol > 0 ? (capitalSol / params.budgetSol) * 100 : 0,
      optimalBudgetSol: capitalSol * (params.budgetHeadroom ?? 1.25),
      sizedCapacity: capacityForBudget(
        params.budgetSol,
        params.basePositionSizeSol * mult,
      ),
    }
  })
}

/** Buckets by the stamped multiplier — the axis the sizing system actually records. */
export function buildSizingBuckets(params: {
  bySizeMult: Array<{
    regime: string | null
    trades: number
    won: number
    lost: number
    sum_pnl_pct: string | number | null
  }>
  basePositionSizeSol: number
}): SizingBucket[] {
  return params.bySizeMult
    .map((row) => {
      const mult = num(row.regime) || 1
      const sumPnlPct = num(row.sum_pnl_pct)
      return {
        sizeMult: mult,
        trades: num(row.trades),
        won: num(row.won),
        lost: num(row.lost),
        sumPnlPct,
        pnlSolSized: pnlSolFor(sumPnlPct * mult, params.basePositionSizeSol),
      }
    })
    .sort((a, b) => a.sizeMult - b.sizeMult)
}

export function summarizeDailyPnl(params: {
  rows: DailyPnlRow[]
  budgetSol: number
  basePositionSizeSol: number
  budgetHeadroom?: number
}): PnlBudgetSummary {
  const { rows, budgetSol, basePositionSizeSol } = params
  const trades = rows.reduce((s, r) => s + r.trades, 0)
  const won = rows.reduce((s, r) => s + r.won, 0)
  const lost = rows.reduce((s, r) => s + r.lost, 0)
  const sumPnlPct = rows.reduce((s, r) => s + r.sumPnlPct, 0)
  const pnlSolFlat = rows.reduce((s, r) => s + r.pnlSolFlat, 0)
  const pnlSolSized = rows.reduce((s, r) => s + r.pnlSolSized, 0)
  const withExec = rows.reduce((s, r) => s + r.withExec, 0)
  const withMult = rows.reduce((s, r) => s + r.withSizeMult, 0)
  const peakConcurrent = rows.reduce((m, r) => Math.max(m, r.peakConcurrent), 0)
  const peakCapitalSol = peakConcurrent * basePositionSizeSol
  const mults = rows.map((r) => r.medianSizeMult).filter((m): m is number => m != null && m > 0)
  const ranked = [...rows].sort((a, b) => b.pnlSolSized - a.pnlSolSized)

  return {
    budgetSol,
    basePositionSizeSol,
    capacity: capacityForBudget(budgetSol, basePositionSizeSol),
    days: rows.length,
    trades,
    won,
    lost,
    winRatePct: trades > 0 ? (won / trades) * 100 : 0,
    sumPnlPct,
    pnlSolFlat,
    pnlSolSized,
    sizingEffectPct: pnlSolFlat !== 0 ? ((pnlSolSized - pnlSolFlat) / Math.abs(pnlSolFlat)) * 100 : 0,
    pnlSolSizedPerDay: rows.length > 0 ? pnlSolSized / rows.length : 0,
    tradesWithSizeMult: withMult,
    medianSizeMult: median(mults),
    execPnlSol: withExec > 0 ? rows.reduce((s, r) => s + (r.execPnlSol ?? 0), 0) : null,
    tradesWithExec: withExec,
    peakConcurrent,
    peakCapitalSol,
    peakBudgetUsedPct: budgetSol > 0 ? (peakCapitalSol / budgetSol) * 100 : 0,
    bestDay: ranked[0] ? { day: ranked[0].day, pnlSol: ranked[0].pnlSolSized } : null,
    worstDay: ranked[ranked.length - 1]
      ? { day: ranked[ranked.length - 1].day, pnlSol: ranked[ranked.length - 1].pnlSolSized }
      : null,
    avgWinPct: won > 0 ? rows.reduce((s, r) => s + r.avgWinPct * r.won, 0) / won : 0,
    avgLossPct: lost > 0 ? rows.reduce((s, r) => s + r.avgLossPct * r.lost, 0) / lost : 0,
    avgRiskSol:
      trades > 0 ? rows.reduce((s, r) => s + r.avgRiskSol * r.trades, 0) / trades : 0,
    avgRewardSol: (() => {
      const winTrades = rows.reduce((s, r) => s + r.won, 0)
      return winTrades > 0
        ? rows.reduce((s, r) => s + r.avgRewardSol * r.won, 0) / winTrades
        : 0
    })(),
    winLossRatio: (() => {
      const loss = won + lost > 0 ? rows.reduce((s, r) => s + r.avgLossPct * r.lost, 0) / (lost || 1) : 0
      const win = won > 0 ? rows.reduce((s, r) => s + r.avgWinPct * r.won, 0) / won : 0
      return loss < 0 ? win / Math.abs(loss) : null
    })(),
    profitFactor: (() => {
      const gw = rows.reduce((s, r) => s + r.grossWinPct, 0)
      const gl = rows.reduce((s, r) => s + r.grossLossPct, 0)
      return gl < 0 ? gw / Math.abs(gl) : null
    })(),
    velocityMaxSol: peakCapitalSol,
    suggestedDailyBudgetSol: rows.reduce((m, r) => Math.max(m, r.optimalBudgetSol), 0),
    budgetHeadroom: params.budgetHeadroom ?? 1.25,
    budgetAdequate: budgetSol >= rows.reduce((m, r) => Math.max(m, r.optimalBudgetSol), 0),
  }
}

export interface RegimePnlBucket {
  regimeTag: string | null
  trades: number
  won: number
  lost: number
  sumPnlPct: number
  pnlSolFlat: number
}

/** PnL per regime tag — the context the regime persistence exists to provide. */
export function buildRegimeBuckets(params: {
  byRegimeTag: Array<{
    regime: string | null
    trades: number
    won: number
    lost: number
    sum_pnl_pct: string | number | null
  }>
  basePositionSizeSol: number
}): RegimePnlBucket[] {
  return params.byRegimeTag
    .map((row) => {
      const sumPnlPct = num(row.sum_pnl_pct)
      return {
        regimeTag: row.regime && row.regime.trim() ? row.regime : null,
        trades: num(row.trades),
        won: num(row.won),
        lost: num(row.lost),
        sumPnlPct,
        pnlSolFlat: pnlSolFor(sumPnlPct, params.basePositionSizeSol),
      }
    })
    .sort((a, b) => b.trades - a.trades)
}
