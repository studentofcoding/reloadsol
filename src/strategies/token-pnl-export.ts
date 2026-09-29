/**
 * Token-level PnL export.
 *
 * Pure helpers: the route and the db layer hand over rows, everything numeric/CSV happens here
 * so the arithmetic is unit-testable. Two rules this module exists to keep:
 *
 * 1. `pnl_sol = position_size_sol * sum_pnl_pct / 100`. A sum of per-trade percentages is NOT a
 *    portfolio return, so the percentage column is only ever shown next to the SOL column that
 *    was derived from an explicit per-position size.
 * 2. Concentration is reported, never hidden: the day's result is usually a handful of trades,
 *    so the top-N share travels with the totals.
 */

/** Per-token aggregate over the exported window. */
export interface TokenPnlRow {
  tokenAddress: string
  symbol: string
  strategies: string[]
  trades: number
  won: number
  lost: number
  priced: number
  sumPnlPct: number
  avgPnlPct: number
  medianPnlPct: number
  firstEntry: string | null
  lastExit: string | null
}

export interface TokenPnlSummary {
  tokens: number
  trades: number
  won: number
  lost: number
  priced: number
  avgPnlPct: number
  medianPnlPct: number
  sumPnlPct: number
  grossWinPct: number
  grossLossPct: number
  /** gross win / |gross loss|; null when there were no losses. */
  profitFactor: number | null
  pnlSol: number
  /** Peak simultaneously-open positions in the window. */
  peakConcurrent: number
  peakCapitalSol: number
  /** Share of the window's PnL carried by the top `concentrationTop` tokens. */
  topSharePct: number
  concentrationTop: number
}

/** pg returns numeric as a string; every read goes through here. */
export function toNum(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

export function pnlSol(sumPnlPct: number, positionSizeSol: number): number {
  return (positionSizeSol * sumPnlPct) / 100
}

/**
 * Roll the per-token rows up. Trade-level totals (win/loss, gross win and loss) are supplied by
 * the caller from SQL because a per-token median cannot be re-aggregated into a trade median.
 */
export function summarizeTokens(params: {
  tokens: TokenPnlRow[]
  trades: number
  won: number
  lost: number
  priced: number
  avgPnlPct: number
  medianPnlPct: number
  grossWinPct: number
  grossLossPct: number
  peakConcurrent: number
  positionSizeSol: number
  concentrationTop?: number
}): TokenPnlSummary {
  const concentrationTop = params.concentrationTop ?? 10
  const sumPnlPct = params.tokens.reduce((s, t) => s + t.sumPnlPct, 0)
  const ranked = [...params.tokens].sort((a, b) => b.sumPnlPct - a.sumPnlPct)
  const topSum = ranked
    .slice(0, concentrationTop)
    .reduce((s, t) => s + Math.max(0, t.sumPnlPct), 0)
  const grossLoss = Math.abs(params.grossLossPct)
  return {
    tokens: params.tokens.length,
    trades: params.trades,
    won: params.won,
    lost: params.lost,
    priced: params.priced,
    avgPnlPct: params.avgPnlPct,
    medianPnlPct: params.medianPnlPct,
    sumPnlPct,
    grossWinPct: params.grossWinPct,
    grossLossPct: params.grossLossPct,
    profitFactor: grossLoss > 0 ? params.grossWinPct / grossLoss : null,
    pnlSol: pnlSol(sumPnlPct, params.positionSizeSol),
    peakConcurrent: params.peakConcurrent,
    peakCapitalSol: params.peakConcurrent * params.positionSizeSol,
    // How much of the window's *winning* PnL the top tokens carry. Deliberately against gross
    // wins, not the net: a day whose net looks fine on one trade should show that plainly.
    topSharePct: params.grossWinPct > 0 ? (topSum / params.grossWinPct) * 100 : 0,
    concentrationTop,
  }
}

export function topTokens(tokens: TokenPnlRow[], n: number): TokenPnlRow[] {
  return [...tokens].sort((a, b) => b.sumPnlPct - a.sumPnlPct).slice(0, n)
}

export function worstTokens(tokens: TokenPnlRow[], n: number): TokenPnlRow[] {
  return [...tokens].sort((a, b) => a.sumPnlPct - b.sumPnlPct).slice(0, n)
}

const CSV_COLUMNS = [
  'section',
  'rank',
  'token_symbol',
  'token_address',
  'strategies',
  'strategy_count',
  'trades',
  'won',
  'lost',
  'win_rate_pct',
  'sum_pnl_pct',
  'avg_pnl_pct',
  'median_pnl_pct',
  'pnl_sol',
  'first_entry',
  'last_exit',
] as const

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`
}

function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',')
}

function round(n: number, digits = 4): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

function tokenRow(
  section: string,
  rank: number | '',
  t: TokenPnlRow,
  positionSizeSol: number,
): string {
  return csvRow([
    section,
    rank,
    t.symbol,
    t.tokenAddress,
    t.strategies.join('|'),
    t.strategies.length,
    t.trades,
    t.won,
    t.lost,
    t.trades > 0 ? round((t.won / t.trades) * 100, 2) : '',
    round(t.sumPnlPct, 2),
    round(t.avgPnlPct, 2),
    round(t.medianPnlPct, 2),
    round(pnlSol(t.sumPnlPct, positionSizeSol), 6),
    t.firstEntry ?? '',
    t.lastExit ?? '',
  ])
}

/**
 * One CSV holding the metadata block, the top winners, the top losers and the full token list.
 * Sections are marked with `#` metadata lines plus a `section` column so a reader can keep the
 * blocks apart while a spreadsheet can still filter the single table.
 */
export function buildTokenPnlCsv(params: {
  summary: TokenPnlSummary
  tokens: TokenPnlRow[]
  positionSizeSol: number
  from: string
  to: string
  timeZone: string
  /** Chains present in the window; more than one means the notional column mixes units. */
  chains?: string[]
  topN?: number
  generatedAt?: string
}): string {
  const topN = params.topN ?? 10
  const chains = params.chains ?? []
  const s = params.summary
  const lines: string[] = [
    '# Token PnL export',
    `# range,${params.from}..${params.to}`,
    `# timezone,${params.timeZone}`,
    `# position_size_sol,${params.positionSizeSol}`,
    `# chains,${chains.length > 0 ? chains.join('|') : ''}`,
    ...(chains.length > 1
      ? [
          `# units_note,chains differ: the notional column is position_size per position in each row's native unit (sol=SOL, robinhood=ETH) — percentages are comparable, notional is not`,
        ]
      : []),
    `# generated_at,${params.generatedAt ?? new Date().toISOString()}`,
    '#',
    `# tokens,${s.tokens}`,
    `# trades,${s.trades}`,
    `# won,${s.won}`,
    `# lost,${s.lost}`,
    `# priced,${s.priced}`,
    `# avg_pnl_pct,${round(s.avgPnlPct, 2)}`,
    `# median_pnl_pct,${round(s.medianPnlPct, 2)}`,
    `# sum_pnl_pct,${round(s.sumPnlPct, 2)}`,
    `# gross_win_pct,${round(s.grossWinPct, 2)}`,
    `# gross_loss_pct,${round(s.grossLossPct, 2)}`,
    `# profit_factor,${s.profitFactor === null ? '' : round(s.profitFactor, 2)}`,
    `# pnl_sol,${round(s.pnlSol, 6)}`,
    `# peak_concurrent,${s.peakConcurrent}`,
    `# peak_capital_sol,${round(s.peakCapitalSol, 6)}`,
    `# top${s.concentrationTop}_share_of_wins_pct,${round(s.topSharePct, 1)}`,
    '#',
    csvRow([...CSV_COLUMNS]),
  ]

  topTokens(params.tokens, topN).forEach((t, i) => {
    lines.push(tokenRow('winner', i + 1, t, params.positionSizeSol))
  })
  worstTokens(params.tokens, topN).forEach((t, i) => {
    lines.push(tokenRow('loser', i + 1, t, params.positionSizeSol))
  })
  ;[...params.tokens]
    .sort((a, b) => b.sumPnlPct - a.sumPnlPct)
    .forEach((t, i) => {
      lines.push(tokenRow('all', i + 1, t, params.positionSizeSol))
    })

  return lines.join('\n')
}

export function tokenPnlFileName(from: string, to: string): string {
  return `token-pnl_${from}_to_${to}.csv`
}

/** YYYY-MM-DD with no time part, as a human picks in a date input. */
export function isValidDayString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const probe = new Date(Date.UTC(y, m - 1, d))
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  )
}

/**
 * The calendar day a moment falls on in `timeZone`. The day a trade belongs to is the trading
 * day the operator lives in, not the UTC day, so the range is anchored in the report timezone
 * and the SQL does the same conversion for the window bounds.
 */
export function dayInTimeZone(moment: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(moment)
  return parts
}
