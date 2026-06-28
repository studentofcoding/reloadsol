import { describe, expect, it } from 'vitest'
import {
  filterPointsToWindow,
  mergeVolumeFromMonitorSnapshots,
  parsePriceHistory,
  readVolumeFromFeatures,
} from '@/strategies/trade-window-chart-data'

describe('parsePriceHistory', () => {
  it('maps legacy volume field to volume_5m', () => {
    const points = parsePriceHistory([
      { timestamp: '2026-06-28T03:00:00.000Z', price_usd: 0.0001, volume: 420 },
      { timestamp: '2026-06-28T04:00:00.000Z', price_usd: 0.0002, volume_5m: 900 },
    ])
    expect(points).toHaveLength(2)
    expect(points[0].volume_5m).toBe(420)
    expect(points[1].volume_5m).toBe(900)
  })

  it('filters points to entry→exit window', () => {
    const points = filterPointsToWindow(
      parsePriceHistory([
        { timestamp: '2026-06-28T02:00:00.000Z', price_usd: 0.0001, volume_5m: 1 },
        { timestamp: '2026-06-28T03:30:00.000Z', price_usd: 0.00015, volume_5m: 2 },
        { timestamp: '2026-06-28T05:00:00.000Z', price_usd: 0.00025, volume_5m: 3 },
      ]),
      '2026-06-28T03:25:00.000Z',
      '2026-06-28T05:30:00.000Z',
    )
    expect(points).toHaveLength(2)
    expect(points[0].volume_5m).toBe(2)
  })
})

describe('mergeVolumeFromMonitorSnapshots', () => {
  it('fills missing tracker volume from nearest monitor snapshot', () => {
    const merged = mergeVolumeFromMonitorSnapshots(
      [
        { timestamp: '2026-06-28T03:30:00.000Z', price_usd: 0.0001 },
        { timestamp: '2026-06-28T04:30:00.000Z', price_usd: 0.0002 },
      ],
      [
        { timestamp: '2026-06-28T03:29:00.000Z', volume_5m: 500 },
        { timestamp: '2026-06-28T04:31:00.000Z', volume_5m: 800 },
      ],
    )
    expect(merged[0].volume_5m).toBe(500)
    expect(merged[1].volume_5m).toBe(800)
  })
})

describe('readVolumeFromFeatures', () => {
  it('prefers pool_volume for DLMM-style features', () => {
    expect(
      readVolumeFromFeatures({
        pool_volume: 12_000,
        volume_at_entry: 100,
      }),
    ).toBe(12_000)
  })
})
