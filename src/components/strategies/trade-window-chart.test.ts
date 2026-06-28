import { describe, expect, it } from 'vitest'
import {
  VOLUME_BAR_DOWN,
  VOLUME_BAR_MISSING,
  VOLUME_BAR_NEUTRAL,
  VOLUME_BAR_UP,
  volumeBarColors,
  volumeBarValues,
} from '@/components/strategies/trade-window-chart-utils'

describe('volumeBarValues', () => {
  it('returns null when volume_5m is missing', () => {
    expect(
      volumeBarValues([
        { timestamp: '2026-06-28T03:25:00.000Z', price_usd: 0.0001, volume_5m: 100 },
        { timestamp: '2026-06-28T04:00:00.000Z', price_usd: 0.0002, volume_5m: null },
      ]),
    ).toEqual([100, null])
  })

  it('preserves raw zero volume', () => {
    expect(
      volumeBarValues([
        { timestamp: '2026-06-28T03:25:00.000Z', price_usd: 0.0001, volume_5m: 0 },
      ]),
    ).toEqual([0])
  })
})

describe('volumeBarColors', () => {
  it('marks first valid bar neutral and missing volume transparent', () => {
    const colors = volumeBarColors([
      { timestamp: '2026-06-28T03:25:00.000Z', price_usd: 0.0001, volume_5m: 100 },
      { timestamp: '2026-06-28T04:00:00.000Z', price_usd: 0.0002, volume_5m: null },
    ])
    expect(colors[0]).toBe(VOLUME_BAR_NEUTRAL)
    expect(colors[1]).toBe(VOLUME_BAR_MISSING)
  })

  it('colors green when volume rises vs prior sample', () => {
    const colors = volumeBarColors([
      { timestamp: '2026-06-28T03:25:00.000Z', price_usd: 0.0001, volume_5m: 100 },
      { timestamp: '2026-06-28T04:00:00.000Z', price_usd: 0.0002, volume_5m: 250 },
    ])
    expect(colors[1]).toBe(VOLUME_BAR_UP)
  })

  it('colors red when volume falls vs prior sample', () => {
    const colors = volumeBarColors([
      { timestamp: '2026-06-28T03:25:00.000Z', price_usd: 0.0001, volume_5m: 500 },
      { timestamp: '2026-06-28T04:00:00.000Z', price_usd: 0.0002, volume_5m: 200 },
    ])
    expect(colors[1]).toBe(VOLUME_BAR_DOWN)
  })
})
