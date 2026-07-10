import { describe, expect, it } from 'vitest'
import { parseDexScreenerTokenVolume } from './dexscreener-volume'

describe('parseDexScreenerTokenVolume', () => {
  it('picks highest-liquidity pair and prefers m5', () => {
    const hints = parseDexScreenerTokenVolume({
      pairs: [
        {
          pairAddress: 'low',
          liquidity: { usd: 100 },
          volume: { m5: 50, h1: 500 },
        },
        {
          pairAddress: 'high',
          liquidity: { usd: 10_000 },
          volume: { m5: 200, h1: 900 },
        },
      ],
    })
    expect(hints).toEqual({
      volume: 200,
      window: 'm5',
      pairAddress: 'high',
    })
  })

  it('falls back m5 → h1 → h24', () => {
    expect(
      parseDexScreenerTokenVolume({
        pairs: [
          {
            pairAddress: 'p1',
            liquidity: { usd: 1 },
            volume: { h1: 77 },
          },
        ],
      }),
    ).toEqual({ volume: 77, window: 'h1', pairAddress: 'p1' })

    expect(
      parseDexScreenerTokenVolume({
        pairs: [
          {
            pairAddress: 'p2',
            liquidity: { usd: 1 },
            volume: { h24: 12 },
          },
        ],
      }),
    ).toEqual({ volume: 12, window: 'h24', pairAddress: 'p2' })
  })

  it('coerces string volumes and returns null when empty', () => {
    expect(
      parseDexScreenerTokenVolume({
        pairs: [
          {
            pairAddress: 's',
            liquidity: { usd: '500' },
            volume: { m5: '33.5' },
          },
        ],
      }),
    ).toEqual({ volume: 33.5, window: 'm5', pairAddress: 's' })

    expect(parseDexScreenerTokenVolume({ pairs: [] })).toBeNull()
    expect(parseDexScreenerTokenVolume(null)).toBeNull()
  })
})
