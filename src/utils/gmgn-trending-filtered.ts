/**
 * Pure map/filter twin of Jupiter /api/trending/filtered for GMGN market rank.
 */

import type { GmgnMarketRankRow } from '@/utils/gmgn-api'
import type { GmgnTradeChain } from '@/utils/gmgn-currencies'

/** Same numeric bands as src/app/api/trending/filtered/route.ts */
export const GMGN_FILTERED_CRITERIA = {
  min_change_5m: -0.4,
  min_organic_score: 70,
  min_mcap: 300_000,
  max_mcap: 2_000_000,
} as const

/**
 * Wider band for Robinhood: its market is too young for many tokens to sit
 * inside the Solana-tuned $300K–$2M window, so a single shared band drops
 * most legitimate RH rows. The organic-score proxy is also a no-op there
 * (saturates at 100), so this is the only effective gate.
 */
export const ROBINHOOD_FILTERED_CRITERIA = {
  min_change_5m: -0.4,
  min_organic_score: 0,
  min_mcap: 25_000,
  max_mcap: 25_000_000,
} as const

export type GmgnFilteredCriteria = {
  readonly min_change_5m: number
  readonly min_organic_score: number
  readonly min_mcap: number
  readonly max_mcap: number
}

export function criteriaForChain(chain: GmgnTradeChain): GmgnFilteredCriteria {
  return chain === 'robinhood' ? ROBINHOOD_FILTERED_CRITERIA : GMGN_FILTERED_CRITERIA
}

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
  /** DLMM-card parity fields (nullable — not all feeds provide them). */
  liquidity?: number
  holders?: number
  launchpad?: string
  twitter?: string
  telegram?: string
  website?: string
  smartDegenCount?: number
  renownedCount?: number
  hotLevel?: number
  visitingCount?: number
  communityCue?: 'komun_ok' | 'komun_thin'
  fomoCue?: 'fomo_hot' | 'fomo_quiet'
  first_seen_at?: string
  first_mcap?: number
}

export function numOrUndef(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

export function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** DLMM-card community cue: present when the token has a Twitter + a social. */
export function gmgnCommunityCue(row: {
  twitter_username?: unknown
  telegram?: unknown
  website?: unknown
}): 'komun_ok' | 'komun_thin' {
  const twitter = strOrUndef(row.twitter_username)
  const telegram = strOrUndef(row.telegram)
  const website = strOrUndef(row.website)
  return twitter && (telegram || website) ? 'komun_ok' : 'komun_thin'
}

/** DLMM-card FOMO cue — hot / strong change / many smart wallets / visits. */
export function gmgnFomoCue(row: {
  hot_level?: unknown
  price_change_percent?: unknown
  smart_degen_count?: unknown
  renowned_count?: unknown
  visiting_count?: unknown
}): 'fomo_hot' | 'fomo_quiet' {
  const hot = numOrUndef(row.hot_level) ?? 0
  const pct = numOrUndef(row.price_change_percent) ?? 0
  const sm = numOrUndef(row.smart_degen_count) ?? 0
  const kol = numOrUndef(row.renowned_count) ?? 0
  const visits = numOrUndef(row.visiting_count) ?? 0
  if (hot >= 2 || pct >= 30 || sm + kol >= 20 || visits >= 200) return 'fomo_hot'
  return 'fomo_quiet'
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

/**
 * Proxy 0–100 from GMGN social/hot signals (no Jupiter organic_score).
 * ponytail: saturates at 100 on robinhood, where smart_degen_count/renowned_count
 * run 50–150, so the >= 70 gate is a no-op there and the effective filter is the
 * mcap band plus change_5m. Upgrade path: percentile-rank the counts per chain.
 */
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
  const change5m =
    row.price_change_percent5m == null
      ? change
      : normalizePriceChangeToFraction(row.price_change_percent5m)
  const mcap = num(row.market_cap)
  const logo =
    typeof row.logo === 'string'
      ? row.logo
      : typeof (row as { logo_url?: unknown }).logo_url === 'string'
        ? String((row as { logo_url: string }).logo_url)
        : undefined
  const launchpad =
    strOrUndef(row.launchpad_platform) ?? strOrUndef(row.launchpad)
  return {
    token_symbol: String(row.symbol ?? '???'),
    token_address: address,
    price: num((row as { price?: unknown }).price),
    change_1h: change,
    change_5m: change5m,
    volume_1h: num(row.volume),
    mcap,
    logo_url: logo,
    organic_score: gmgnOrganicScoreProxy(row),
    liquidity: numOrUndef(row.liquidity),
    holders: numOrUndef(row.holder_count),
    launchpad,
    twitter: strOrUndef(row.twitter_username),
    telegram: strOrUndef(row.telegram),
    website: strOrUndef(row.website),
    smartDegenCount: numOrUndef(row.smart_degen_count),
    renownedCount: numOrUndef(row.renowned_count),
    hotLevel: numOrUndef(row.hot_level),
    visitingCount: numOrUndef(row.visiting_count),
    communityCue: gmgnCommunityCue(row),
    fomoCue: gmgnFomoCue(row),
  }
}

export function passesGmgnFilteredCriteria(
  token: GmgnFilteredTrendingToken,
  chain?: GmgnTradeChain,
): boolean {
  const c = chain ? criteriaForChain(chain) : GMGN_FILTERED_CRITERIA
  return (
    token.change_5m > c.min_change_5m &&
    token.organic_score >= c.min_organic_score &&
    token.mcap > c.min_mcap &&
    token.mcap < c.max_mcap
  )
}

export function filterAndSortGmgnTrending(
  rows: GmgnMarketRankRow[],
  chain?: GmgnTradeChain,
): {
  tokens: GmgnFilteredTrendingToken[]
  total_before_filter: number
  total_after_filter: number
} {
  const mapped = rows
    .map(mapGmgnRankToFilteredToken)
    .filter((t): t is GmgnFilteredTrendingToken => t != null)
  const filtered = mapped.filter((t) => passesGmgnFilteredCriteria(t, chain))
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
