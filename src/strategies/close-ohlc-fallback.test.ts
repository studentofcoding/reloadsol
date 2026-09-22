import { describe, expect, it } from 'vitest'
import type { OhlcRugBar } from '@/strategies/ohlc-rug-rules'
import {
  formatGmgnChartFallbackLine,
  resolveCloseOhlcBars,
} from './close-ohlc-fallback'

function bar(c: number): OhlcRugBar {
  return { t: 1, o: c, h: c, l: c, c }
}

const liveBar = bar(2)
const labelBar = bar(9)

describe('resolveCloseOhlcBars', () => {
  it('prefers live Tracker bars when they exist', async () => {
    const resolved = await resolveCloseOhlcBars('mint', {
      liveWaitMs: 200,
      loadLive: async () => [liveBar],
      loadLabels: async () => [labelBar],
    })
    expect(resolved.source).toBe('live')
    expect(resolved.bars).toEqual([liveBar])
  })

  it('paints stored label bars when live is empty', async () => {
    const resolved = await resolveCloseOhlcBars('mint', {
      liveWaitMs: 200,
      loadLive: async () => [],
      loadLabels: async () => [labelBar],
    })
    expect(resolved.source).toBe('labels')
    expect(resolved.bars).toEqual([labelBar])
  })

  it('does not wait out a slow live fetch when labels already have bars', async () => {
    let liveFinished = false
    const resolved = await resolveCloseOhlcBars('mint', {
      liveWaitMs: 30,
      loadLive: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            liveFinished = true
            resolve([liveBar])
          }, 250)
        }),
      loadLabels: async () => [labelBar],
    })
    expect(resolved.source).toBe('labels')
    expect(resolved.bars).toEqual([labelBar])
    expect(liveFinished).toBe(false)
  })

  it('returns no bars (GMGN text, not a fake chart) when both are empty', async () => {
    const resolved = await resolveCloseOhlcBars('FOMOMINT', {
      liveWaitMs: 50,
      loadLive: async () => [],
      loadLabels: async () => [],
    })
    expect(resolved).toEqual({ bars: [], source: 'none' })
    expect(formatGmgnChartFallbackLine('FOMOMINT')).toContain('gmgn.cc/kline/')
    expect(formatGmgnChartFallbackLine('FOMOMINT')).toContain('FOMOMINT')
  })

  it('still uses live bars when labels are empty and live returns after the wait', async () => {
    const resolved = await resolveCloseOhlcBars('mint', {
      liveWaitMs: 20,
      loadLive: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve([liveBar]), 40)
        }),
      loadLabels: async () => [],
    })
    expect(resolved.source).toBe('live')
    expect(resolved.bars).toEqual([liveBar])
  })
})
