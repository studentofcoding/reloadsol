/** Read numeric field from stats (top-level or one nested object). */
function readNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

const BOUGHT_AVG_MC_KEYS = [
  'bought_avg_mc',
  'bought_avg_market_cap',
  'avg_bought_mc',
  'avg_buy_mc',
  'buy_avg_mc',
  'boughtAvgMc',
  'avg_buy_market_cap',
] as const

const SOLD_AVG_MC_KEYS = [
  'sold_avg_mc',
  'sold_avg_market_cap',
  'avg_sold_mc',
  'avg_sell_mc',
  'sell_avg_mc',
  'soldAvgMc',
  'avg_sell_market_cap',
] as const

function pickNum(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const k of keys) {
    const n = readNum(record[k])
    if (n != null) return n
  }
  return null
}

function nestedObjects(stats: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [stats]
  for (const v of Object.values(stats)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(v as Record<string, unknown>)
    }
  }
  return out
}

export type AvgMcEdge = {
  boughtAvgMc: number | null
  soldAvgMc: number | null
}

/** Peek-friendly extractor — GMGN UI labels; openapi stats often omit these. */
export function readAvgMcEdge(stats: Record<string, unknown>): AvgMcEdge {
  let boughtAvgMc: number | null = null
  let soldAvgMc: number | null = null
  for (const obj of nestedObjects(stats)) {
    if (boughtAvgMc == null) boughtAvgMc = pickNum(obj, BOUGHT_AVG_MC_KEYS)
    if (soldAvgMc == null) soldAvgMc = pickNum(obj, SOLD_AVG_MC_KEYS)
  }
  return { boughtAvgMc, soldAvgMc }
}

/** Fail closed: both present and sold > bought. */
export function passesSoldAboveBoughtMc(stats: Record<string, unknown>): boolean {
  const { boughtAvgMc, soldAvgMc } = readAvgMcEdge(stats)
  if (boughtAvgMc == null || soldAvgMc == null) return false
  return soldAvgMc > boughtAvgMc
}

/** Align with live wallet_stats shape (buy / pnl_stat.winrate / realized_profit_pnl). */
export function readPortfolioBars(stats: Record<string, unknown>): {
  winrate: number
  buyCount: number
  pnl: number
} {
  const pnlStat =
    stats.pnl_stat && typeof stats.pnl_stat === 'object'
      ? (stats.pnl_stat as Record<string, unknown>)
      : null
  return {
    winrate: readNum(stats.winrate) ?? readNum(pnlStat?.winrate) ?? 0,
    buyCount: readNum(stats.buy_count) ?? readNum(stats.buy) ?? 0,
    pnl: readNum(stats.pnl) ?? readNum(stats.realized_profit_pnl) ?? 0,
  }
}
