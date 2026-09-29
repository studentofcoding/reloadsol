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
  withSizeMult: number
  withExec: number
  execPnlSol: number | null
  peakConcurrent: number
  capitalSol: number
  budgetUsedPct: number
  capacity: number
  /** Capacity once the day's median multiplier is applied. */
  sizedCapacity: number
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
}): DailyPnlRow[] {
  const peakByDay = new Map(params.peaks.map((p) => [p.day, num(p.peak_open)]))
  return params.daily.map((row) => {
    const sumPnlPct = num(row.sum_pnl_pct)
    const sumWeighted = num(row.sum_pnl_pct_weighted ?? row.sum_pnl_pct)
    const medianMult = row.median_size_mult == null ? null : num(row.median_size_mult)
    const peakConcurrent = peakByDay.get(row.day) ?? 0
    const capitalSol = peakConcurrent * params.basePositionSizeSol
    const mult = medianMult && medianMult > 0 ? medianMult : 1
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
      withSizeMult: num(row.with_size_mult),
      withExec: num(row.with_exec),
      execPnlSol: num(row.with_exec) > 0 ? num(row.exec_pnl_quote) : null,
      peakConcurrent,
      capitalSol,
      budgetUsedPct: params.budgetSol > 0 ? (capitalSol / params.budgetSol) * 100 : 0,
      capacity: capacityForBudget(params.budgetSol, params.basePositionSizeSol),
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
  }
}
