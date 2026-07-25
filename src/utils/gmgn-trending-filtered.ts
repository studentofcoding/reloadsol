/**
 * Pure map/filter twin of Jupiter /api/trending/filtered for GMGN market rank.
 */

import type { GmgnMarketRankRow } from '@/utils/gmgn-api'

/** Same numeric bands as src/app/api/trending/filtered/route.ts */
export const GMGN_FILTERED_CRITERIA = {
  min_change_5m: -0.4,
  min_organic_score: 70,
  min_mcap: 300_000,
  max_mcap: 2_000_000,
} as const

export type GmgnFilteredTrendingToken = {
  token_symbol: string
  token_address: string
  price: number
  change_1h: number
  change_5m: number
  volume_1h: number
  mcap: number
  logo_url?: string
  organic_score: number
}

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

/** GMGN often sends percent (13.5); Jupiter uses fraction (0.135). */
export function normalizePriceChangeToFraction(raw: unknown): number {
  const n = num(raw)
  if (n === 0) return 0
  return Math.abs(n) > 1 ? n / 100 : n
}

/** Proxy 0–100 from GMGN social/hot signals (no Jupiter organic_score). */
export function gmgnOrganicScoreProxy(row: GmgnMarketRankRow): number {
  const hot = num(row.hot_level)
  const smart = num(row.smart_degen_count)
  const renowned = num(row.renowned_count)
  return Math.min(100, hot * 25 + smart * 5 + renowned * 5)
}

export function mapGmgnRankToFilteredToken(
  row: GmgnMarketRankRow,
): GmgnFilteredTrendingToken | null {
  const address = String(row.address ?? '').trim()
  if (!address) return null
  const change = normalizePriceChangeToFraction(row.price_change_percent)
  const mcap = num(row.market_cap)
  const logo =
    typeof row.logo === 'string'
      ? row.logo
      : typeof (row as { logo_url?: unknown }).logo_url === 'string'
        ? String((row as { logo_url: string }).logo_url)
        : undefined
  return {
    token_symbol: String(row.symbol ?? '???'),
    token_address: address,
    price: num((row as { price?: unknown }).price),
    change_1h: change,
    // ponytail: one 1h rank call — reuse as change_5m until a second interval fetch
    change_5m: change,
    volume_1h: num(row.volume),
    mcap,
    logo_url: logo,
    organic_score: gmgnOrganicScoreProxy(row),
  }
}

export function passesGmgnFilteredCriteria(
  token: GmgnFilteredTrendingToken,
): boolean {
  const c = GMGN_FILTERED_CRITERIA
  return (
    token.change_5m > c.min_change_5m &&
    token.organic_score >= c.min_organic_score &&
    token.mcap > c.min_mcap &&
    token.mcap < c.max_mcap
  )
}

export function filterAndSortGmgnTrending(
  rows: GmgnMarketRankRow[],
): {
  tokens: GmgnFilteredTrendingToken[]
  total_before_filter: number
  total_after_filter: number
} {
  const mapped = rows
    .map(mapGmgnRankToFilteredToken)
    .filter((t): t is GmgnFilteredTrendingToken => t != null)
  const filtered = mapped.filter(passesGmgnFilteredCriteria)
  filtered.sort((a, b) => {
    if (b.organic_score !== a.organic_score) {
      return b.organic_score - a.organic_score
    }
    return Math.abs(b.change_1h) - Math.abs(a.change_1h)
  })
  return {
    tokens: filtered,
    total_before_filter: mapped.length,
    total_after_filter: filtered.length,
  }
}
