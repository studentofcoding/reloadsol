import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeOhlcRugIntoEntryFeatures } from '@/strategies/ohlc-rug-shadow'
import type { OhlcRugEval } from '@/strategies/ohlc-rug-rules'

describe('mergeOhlcRugIntoEntryFeatures', () => {
  it('attaches trip flags and hit ids', () => {
    const evalResult: OhlcRugEval = {
      trip: true,
      features: {
        n: 2,
        dumpPct: 0.5,
        avgUpperWick: 0.1,
        wickTripBars: 0,
        volDeathRatio: null,
      },
      hits: [
        {
          id: 'dump_10m',
          label: 'Dump',
          value: 0.5,
          threshold: 0.4,
          passed: true,
        },
        {
          id: 'wick_reject',
          label: 'Wick',
          value: 0.1,
          threshold: 0.6,
          passed: false,
        },
      ],
    }
    const merged = mergeOhlcRugIntoEntryFeatures({ foo: 1 }, evalResult, 't0')
    expect(merged.foo).toBe(1)
    expect(merged.ohlc_rug_trip).toBe(1)
    expect(merged.ohlc_rug_would_reject).toBe(1)
    expect(merged.ohlc_rug_hits).toEqual(['dump_10m'])
    expect(merged.ohlc_rug_dump_pct).toBe(0.5)
    expect(merged.ohlc_rug_shadow_at).toBe('t0')
  })
})

describe('attachOhlcRugShadow', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('shadow mode does not reject on trip', async () => {
    vi.resetModules()
    vi.doMock('@/strategies/detect-snapshots', () => ({
      fetchLastOhlcRugBars: vi.fn().mockResolvedValue({
        bars: [
          { t: 1, o: 100, h: 100, l: 50, c: 100 },
          { t: 2, o: 60, h: 60, l: 50, c: 60 },
        ],
        source: 'test',
      }),
    }))
    const { attachOhlcRugShadow } = await import('@/strategies/ohlc-rug-shadow')
    const result = await attachOhlcRugShadow('MintShadow1', { a: 1 }, {
      enforce: false,
    })
    expect(result.trip).toBe(true)
    expect(result.reject).toBe(false)
    expect(result.features.ohlc_rug_trip).toBe(1)
    expect(result.features.a).toBe(1)
  })

  it('enforce mode rejects on trip', async () => {
    vi.resetModules()
    vi.doMock('@/strategies/detect-snapshots', () => ({
      fetchLastOhlcRugBars: vi.fn().mockResolvedValue({
        bars: [
          { t: 1, o: 100, h: 100, l: 50, c: 100 },
          { t: 2, o: 60, h: 60, l: 50, c: 60 },
        ],
        source: 'test',
      }),
    }))
    const { attachOhlcRugShadow } = await import('@/strategies/ohlc-rug-shadow')
    const result = await attachOhlcRugShadow('MintShadow2', {}, { enforce: true })
    expect(result.trip).toBe(true)
    expect(result.reject).toBe(true)
    expect(result.reason).toMatch(/dump_10m/)
  })

  it('skips without reject when no bars', async () => {
    vi.resetModules()
    vi.doMock('@/strategies/detect-snapshots', () => ({
      fetchLastOhlcRugBars: vi.fn().mockResolvedValue({
        bars: [],
        source: 'none',
      }),
    }))
    const { attachOhlcRugShadow } = await import('@/strategies/ohlc-rug-shadow')
    const result = await attachOhlcRugShadow('MintEmpty', {}, { enforce: true })
    expect(result.reject).toBe(false)
    expect(result.features.ohlc_rug_skipped).toBe('no_bars_or_error')
  })
})
