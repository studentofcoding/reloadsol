import { describe, expect, it } from 'vitest'
import {
  VOLUME_BAR_DOWN,
  VOLUME_BAR_NEUTRAL,
  VOLUME_BAR_UP,
  volumeBarColors,
} from '@/components/strategies/trade-window-chart-utils'

describe('volumeBarColors', () => {
  it('marks first bar and null volume as neutral', () => {
    const colors = volumeBarColors([
      { timestamp: '2026-06-28T03:25:00.000Z', price_usd: 0.0001, volume_5m: 100 },
      { timestamp: '2026-06-28T04:00:00.000Z', price_usd: 0.0002, volume_5m: null },
    ])
    expect(colors[0]).toBe(VOLUME_BAR_NEUTRAL)
    expect(colors[1]).toBe(VOLUME_BAR_NEUTRAL)
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
