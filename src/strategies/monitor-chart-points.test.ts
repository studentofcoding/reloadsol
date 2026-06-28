import { describe, expect, it } from 'vitest'
import {
  enrichFeaturesWithMonitorSnapshots,
  mergeMonitorSnapshots,
  monitorSnapshotsToChartPoints,
  priceHistoryToMonitorSnapshots,
} from '@/strategies/entry-feature-snapshot'

describe('monitorSnapshotsToChartPoints', () => {
  const entryAt = '2026-06-28T03:25:01.000Z'
  const exitAt = '2026-06-28T05:30:03.000Z'

  it('filters snapshots to entry→exit window', () => {
    const points = monitorSnapshotsToChartPoints(
      [
        { timestamp: '2026-06-28T03:00:00.000Z', price_usd: 0.0001, volume_5m: 100 },
        { timestamp: '2026-06-28T03:30:00.000Z', price_usd: 0.00015, volume_5m: 200 },
        { timestamp: '2026-06-28T05:00:00.000Z', price_usd: 0.00025, volume_5m: 150 },
        { timestamp: '2026-06-28T06:00:00.000Z', price_usd: 0.0003, volume_5m: 50 },
      ],
      entryAt,
      exitAt,
    )
    expect(points).toHaveLength(2)
    expect(points[0].volume_5m).toBe(200)
    expect(points[1].price_usd).toBe(0.00025)
  })

  it('derives price from market_cap when price_usd missing', () => {
    const points = monitorSnapshotsToChartPoints(
      [
        { timestamp: '2026-06-28T04:00:00.000Z', market_cap: 200_000, volume_5m: 500 },
        { timestamp: '2026-06-28T05:00:00.000Z', market_cap: 300_000, volume_5m: 800 },
      ],
      entryAt,
      exitAt,
      { initialPriceUsd: 0.0001, entryMcap: 100_000 },
    )
    expect(points).toHaveLength(2)
    expect(points[0].price_usd).toBeCloseTo(0.0002)
    expect(points[1].price_usd).toBeCloseTo(0.0003)
  })

  it('returns empty when no usable snapshots in window', () => {
    const points = monitorSnapshotsToChartPoints(
      [{ timestamp: '2026-06-28T02:00:00.000Z', price_usd: 0.0001 }],
      entryAt,
      exitAt,
    )
    expect(points).toHaveLength(0)
  })
})

describe('priceHistoryToMonitorSnapshots', () => {
  it('converts clipped price history into monitor snapshots', () => {
    const snapshots = priceHistoryToMonitorSnapshots(
      [
        { timestamp: '2026-06-28T03:30:00.000Z', price_usd: 0.0001, volume_5m: 100 },
        { timestamp: '2026-06-28T05:00:00.000Z', price_usd: 0.0002, volume_5m: 200 },
      ],
      '2026-06-28T03:25:01.000Z',
      '2026-06-28T05:30:03.000Z',
    )
    expect(snapshots).toHaveLength(2)
    expect(snapshots[1].volume_5m).toBe(200)
  })
})

describe('mergeMonitorSnapshots', () => {
  it('dedupes by timestamp and keeps latest', () => {
    const merged = mergeMonitorSnapshots(
      [{ timestamp: '2026-06-28T04:00:00.000Z', volume_5m: 100 }],
      [{ timestamp: '2026-06-28T04:00:00.000Z', volume_5m: 250 }],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].volume_5m).toBe(250)
  })
})

describe('enrichFeaturesWithMonitorSnapshots', () => {
  it('backfills volume_at_entry from first merged snapshot', () => {
    const enriched = enrichFeaturesWithMonitorSnapshots(
      { organic_score: 50 },
      [{ timestamp: '2026-06-28T04:00:00.000Z', volume_5m: 777, price_usd: 0.001 }],
    )
    expect(enriched.volume_at_entry).toBe(777)
    expect(Array.isArray(enriched.monitor_snapshots)).toBe(true)
  })
})
