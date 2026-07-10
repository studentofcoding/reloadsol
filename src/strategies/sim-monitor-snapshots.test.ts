import { describe, expect, it, vi, beforeEach } from 'vitest'
import { parseJupiterV2MarketHints } from '@/utils/jupiter-metadata'

describe('parseJupiterV2MarketHints', () => {
  it('parses usdPrice and buy+sell volume from array response', () => {
    const hints = parseJupiterV2MarketHints(
      [
        {
          id: 'MintA',
          usdPrice: 0.0012,
          stats5m: { buyVolume: 100, sellVolume: 40 },
        },
      ],
      'MintA',
    )
    expect(hints).toEqual({
      usdPrice: 0.0012,
      volume5m: 140,
      mcap: null,
      volumeWindow: '5m',
    })
  })

  it('matches mint when multiple tokens returned', () => {
    const hints = parseJupiterV2MarketHints(
      [
        { id: 'Other', usdPrice: 9, stats5m: { buyVolume: 1, sellVolume: 1 } },
        {
          id: 'MintB',
          usdPrice: 0.5,
          stats5m: { buyVolume: 10, sellVolume: 5 },
        },
      ],
      'MintB',
    )
    expect(hints).toEqual({
      usdPrice: 0.5,
      volume5m: 15,
      mcap: null,
      volumeWindow: '5m',
    })
  })

  it('treats missing buy or sell as zero when the other is present', () => {
    expect(
      parseJupiterV2MarketHints({
        id: 'X',
        usdPrice: 1,
        stats5m: { buyVolume: 25 },
      }),
    ).toEqual({ usdPrice: 1, volume5m: 25, mcap: null, volumeWindow: '5m' })

    expect(
      parseJupiterV2MarketHints({
        id: 'Y',
        stats5m: { sellVolume: 7 },
      }),
    ).toEqual({ usdPrice: null, volume5m: 7, mcap: null, volumeWindow: '5m' })
  })

  it('returns null when neither price nor volume is present', () => {
    expect(parseJupiterV2MarketHints([{ id: 'Z', symbol: 'Z' }], 'Z')).toBeNull()
    expect(parseJupiterV2MarketHints(null)).toBeNull()
    expect(parseJupiterV2MarketHints([])).toBeNull()
  })

  it('ignores non-finite numbers', () => {
    expect(
      parseJupiterV2MarketHints({
        usdPrice: Number.NaN,
        stats5m: { buyVolume: Number.POSITIVE_INFINITY, sellVolume: 3 },
      }),
    ).toEqual({ usdPrice: null, volume5m: 3, mcap: null, volumeWindow: '5m' })
  })

  it('parses mcap from v2 search', () => {
    expect(
      parseJupiterV2MarketHints({
        id: 'Z',
        usdPrice: 0.01,
        mcap: 85_000,
        stats5m: { buyVolume: 1, sellVolume: 1 },
      }),
    ).toEqual({
      usdPrice: 0.01,
      volume5m: 2,
      mcap: 85_000,
      volumeWindow: '5m',
    })
  })
})

vi.mock('@/utils/db', () => ({
  queryOne: vi.fn(),
}))

vi.mock('@/utils/jupiter-metadata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/jupiter-metadata')>()
  return {
    ...actual,
    fetchJupiterMarketHints: vi.fn(),
  }
})

import { queryOne } from '@/utils/db'
import { fetchJupiterMarketHints } from '@/utils/jupiter-metadata'
import { resolveTokenMonitorSnapshot } from './sim-monitor-snapshots'

describe('resolveTokenMonitorSnapshot waterfall', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses tracker metrics when present and skips Jupiter', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      volume_5m: 500,
      last_price_usd: 0.02,
      price_history: null,
    })

    const snap = await resolveTokenMonitorSnapshot('mint1', 100_000)

    expect(snap.price_usd).toBe(0.02)
    expect(snap.volume_5m).toBe(500)
    expect(snap.market_cap).toBe(100_000)
    expect(fetchJupiterMarketHints).not.toHaveBeenCalled()
  })

  it('falls back to mcap volume then Jupiter for missing price/volume', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(null) // tracker miss
      .mockResolvedValueOnce({ volume_5m: null }) // mcap miss volume
    vi.mocked(fetchJupiterMarketHints).mockResolvedValueOnce({
      usdPrice: 0.0004,
      volume5m: 1200,
      mcap: 50_000,
      volumeWindow: '5m',
    })

    const snap = await resolveTokenMonitorSnapshot('mint2', 50_000)

    expect(fetchJupiterMarketHints).toHaveBeenCalledWith('mint2')
    expect(snap).toMatchObject({
      price_usd: 0.0004,
      volume_5m: 1200,
      market_cap: 50_000,
    })
  })

  it('uses mcap volume and only calls Jupiter for missing price', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ volume_5m: 333 })
    vi.mocked(fetchJupiterMarketHints).mockResolvedValueOnce({
      usdPrice: 0.01,
      volume5m: 999,
      mcap: null,
      volumeWindow: '1h',
    })

    const snap = await resolveTokenMonitorSnapshot('mint3', null)

    expect(snap.volume_5m).toBe(333)
    expect(snap.price_usd).toBe(0.01)
    expect(fetchJupiterMarketHints).toHaveBeenCalledOnce()
  })

  it('skips Jupiter when tracker has price and mcap fills volume', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce({
        volume_5m: null,
        last_price_usd: 0.05,
        price_history: null,
      })
      .mockResolvedValueOnce({ volume_5m: 88 })

    const snap = await resolveTokenMonitorSnapshot('mint4', 10_000)

    expect(snap.price_usd).toBe(0.05)
    expect(snap.volume_5m).toBe(88)
    expect(fetchJupiterMarketHints).not.toHaveBeenCalled()
  })
})
