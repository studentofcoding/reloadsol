import { describe, expect, it } from 'vitest'
import { sortTrendingTokens, trendingAgeMs } from './trending-token-sort'

describe('trendingAgeMs', () => {
  it('prefers first_seen_at over created_at', () => {
    expect(
      trendingAgeMs({
        first_seen_at: '2026-09-01T00:00:00.000Z',
        created_at: 1,
      }),
    ).toBe(Date.parse('2026-09-01T00:00:00.000Z'))
  })
})

describe('sortTrendingTokens', () => {
  const tokens = [
    { id: 'old', first_seen_at: '2026-01-01T00:00:00.000Z', mcap: 50 },
    { id: 'new', first_seen_at: '2026-09-01T00:00:00.000Z', mcap: 10 },
    { id: 'mid', first_seen_at: '2026-06-01T00:00:00.000Z', mcap: 200 },
  ]

  it('sorts newest first', () => {
    expect(sortTrendingTokens(tokens, 'newest').map((t) => t.id)).toEqual([
      'new',
      'mid',
      'old',
    ])
  })

  it('sorts oldest first', () => {
    expect(sortTrendingTokens(tokens, 'oldest').map((t) => t.id)).toEqual([
      'old',
      'mid',
      'new',
    ])
  })

  it('sorts top and low mcap', () => {
    expect(sortTrendingTokens(tokens, 'mcap_high').map((t) => t.id)).toEqual([
      'mid',
      'old',
      'new',
    ])
    expect(sortTrendingTokens(tokens, 'mcap_low').map((t) => t.id)).toEqual([
      'new',
      'old',
      'mid',
    ])
  })
})
