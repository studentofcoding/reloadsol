import { compareNum } from '@/utils/dlmm/table-sort'

export type TrendingSort = 'newest' | 'oldest' | 'mcap_high' | 'mcap_low'

export type SortableTrendingToken = {
  mcap?: number
  first_seen_at?: string
  created_at?: number
}

/** Prefer our first sighting; fall back to pool created_at (seconds or ms). */
export function trendingAgeMs(token: SortableTrendingToken): number | undefined {
  if (token.first_seen_at) {
    const n = Date.parse(token.first_seen_at)
    if (Number.isFinite(n)) return n
  }
  if (typeof token.created_at === 'number' && Number.isFinite(token.created_at)) {
    return token.created_at > 1_000_000_000_000
      ? token.created_at
      : token.created_at * 1000
  }
  return undefined
}

export function sortTrendingTokens<T extends SortableTrendingToken>(
  tokens: T[],
  sort: TrendingSort,
): T[] {
  const copy = tokens.slice()
  copy.sort((a, b) => {
    if (sort === 'mcap_high') return compareNum(a.mcap, b.mcap, 'desc')
    if (sort === 'mcap_low') return compareNum(a.mcap, b.mcap, 'asc')
    const dir = sort === 'newest' ? 'desc' : 'asc'
    return compareNum(trendingAgeMs(a), trendingAgeMs(b), dir)
  })
  return copy
}
