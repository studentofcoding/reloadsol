import { describe, expect, it } from 'vitest'
import { parseJupiterV2MarketHints } from './jupiter-metadata'

describe('parseJupiterV2MarketHints volume windows', () => {
  it('uses stats5m when present and stamps window', () => {
    expect(
      parseJupiterV2MarketHints({
        id: 'A',
        usdPrice: 1,
        stats5m: { buyVolume: 10, sellVolume: 5 },
        stats1h: { buyVolume: 999, sellVolume: 0 },
      }),
    ).toEqual({
      usdPrice: 1,
      volume5m: 15,
      mcap: null,
      volumeWindow: '5m',
    })
  })

  it('falls back stats5m → 1h → 6h → 24h', () => {
    expect(
      parseJupiterV2MarketHints({
        id: 'B',
        stats1h: { buyVolume: '20', sellVolume: '5' },
      }),
    ).toEqual({
      usdPrice: null,
      volume5m: 25,
      mcap: null,
      volumeWindow: '1h',
    })

    expect(
      parseJupiterV2MarketHints({
        id: 'C',
        stats6h: { buyVolume: 40 },
      }),
    ).toMatchObject({ volume5m: 40, volumeWindow: '6h' })

    expect(
      parseJupiterV2MarketHints({
        id: 'D',
        stats24h: { sellVolume: 8 },
      }),
    ).toMatchObject({ volume5m: 8, volumeWindow: '24h' })
  })

  it('coerces numeric strings for price and volume', () => {
    expect(
      parseJupiterV2MarketHints({
        id: 'E',
        usdPrice: '0.05',
        mcap: '12000',
        stats5m: { buyVolume: '3', sellVolume: '2' },
      }),
    ).toEqual({
      usdPrice: 0.05,
      volume5m: 5,
      mcap: 12_000,
      volumeWindow: '5m',
    })
  })

  it('returns null volumeWindow when no stats windows have volume', () => {
    expect(
      parseJupiterV2MarketHints({
        id: 'F',
        usdPrice: 0.1,
        mcap: 50_000,
      }),
    ).toEqual({
      usdPrice: 0.1,
      volume5m: null,
      mcap: 50_000,
      volumeWindow: null,
    })
  })
})
