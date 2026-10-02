import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ohlcvMinutesToRugBars,
  rugSignalLookbackMs,
  selectRugSignalBars,
} from '@/strategies/rug-signal-detect'
import {
  DEFAULT_RUG_SIGNAL_THRESHOLDS,
  evaluateRugSignalFrom1m,
  type RugSignalBar,
} from '@/strategies/rug-signal'
import type { OhlcvMinute } from '@/strategies/token-metrics-history'

const BASE_SEC = 1_790_000_000

/** 1m bars on a steady ramp: price +1% every 5 minutes, dead-flat volume. */
function risingFlatVolume1m(count = 120): RugSignalBar[] {
  const bars: RugSignalBar[] = []
  let price = 1
  for (let i = 0; i < count; i++) {
    if (i > 0 && i % 5 === 0) price *= 1.01
    bars.push({
      t: BASE_SEC + i * 60,
      o: price,
      h: price * 1.001,
      l: price * 0.999,
      c: price,
      v: 100,
    })
  }
  return bars
}

function ohlcvFrom(bars: RugSignalBar[]): OhlcvMinute[] {
  return bars.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? null }))
}

describe('rug-signal-detect — series → bars', () => {
  it('carries volume only when it was observed', () => {
    const bars = ohlcvMinutesToRugBars([
      { t: BASE_SEC, o: 1, h: 2, l: 0.5, c: 1.5, v: 7 },
      { t: BASE_SEC + 60, o: 1, h: 2, l: 0.5, c: 1.5, v: null },
    ])
    expect(bars).toEqual([
      { t: BASE_SEC, o: 1, h: 2, l: 0.5, c: 1.5, v: 7 },
      { t: BASE_SEC + 60, o: 1, h: 2, l: 0.5, c: 1.5 },
    ])
    // An absent volume must not become a 0 — the band would read a fabricated "flat".
    expect('v' in bars[1]!).toBe(false)
  })

  it('drops minutes with no usable price, and keeps the rest', () => {
    const bars = ohlcvMinutesToRugBars([
      { t: BASE_SEC, o: 1, h: 2, l: 0.5, c: 1.5, v: 7 },
      { t: BASE_SEC + 60, o: null, h: null, l: null, c: null, v: 5 },
      { t: BASE_SEC + 120, o: 2, h: 3, l: 1, c: 2.5, v: 9 },
    ])
    expect(bars.map((b) => b.t)).toEqual([BASE_SEC, BASE_SEC + 120])
  })

  it('handles an empty series', () => {
    expect(ohlcvMinutesToRugBars([])).toEqual([])
  })
})

describe('rug-signal-detect — lookback', () => {
  it('scales with the window and keeps a floor', () => {
    const wide = rugSignalLookbackMs(DEFAULT_RUG_SIGNAL_THRESHOLDS.windowBars)
    expect(wide).toBe(Math.max(DEFAULT_RUG_SIGNAL_THRESHOLDS.windowBars * 5, 60) * 60_000 * 4)
    expect(rugSignalLookbackMs(1)).toBe(60 * 60_000 * 4)
    expect(rugSignalLookbackMs(Number.NaN)).toBe(20 * 5 * 60_000 * 4)
  })
})

/**
 * The acceptance test for P1: before this the scorer's bars came from `token_ohlc_bars` (volume NULL
 * on every row) and the 24h cache, so the 30-point volume band scored 0 and the ceiling was 60 < the
 * 80 threshold — the signal could never trip, whatever it saw.
 */
describe('rug-signal-detect — the volume band is reachable (P1)', () => {
  const thresholds = DEFAULT_RUG_SIGNAL_THRESHOLDS

  it('contributes points when the bars carry volume, and none when they cannot', () => {
    const withVolume = risingFlatVolume1m()
    const withoutVolume = withVolume.map(({ t, o, h, l, c }) => ({ t, o, h, l, c }))

    const fed = evaluateRugSignalFrom1m(
      { bars1m: withVolume, mcap: 500_000, liquidityUsd: 5_000, ageHours: 1 },
      thresholds,
    )
    const starved = evaluateRugSignalFrom1m(
      { bars1m: withoutVolume, mcap: 500_000, liquidityUsd: 5_000, ageHours: 1 },
      thresholds,
    )

    expect(fed.breakdown.volume).toBeGreaterThan(0)
    expect(starved.breakdown.volume).toBe(0)
    expect(fed.score).toBeGreaterThan(starved.score)
    // The old starved ceiling: staircase 40 + liquidity 20, band and dump inert.
    expect(starved.score).toBeLessThanOrEqual(60)
  })

  it('survives the series round trip — arrays in, bars out, band fed', () => {
    const bars = ohlcvMinutesToRugBars(ohlcvFrom(risingFlatVolume1m()))
    const evalResult = evaluateRugSignalFrom1m(
      { bars1m: bars, mcap: 500_000, liquidityUsd: 5_000, ageHours: 1 },
      thresholds,
    )
    expect(evalResult.breakdown.volume).toBeGreaterThan(0)
  })
})

describe('rug-signal-detect — series shorter than minBars falls back to own-1m', () => {
  const minBars = DEFAULT_RUG_SIGNAL_THRESHOLDS.minBars
  const full = risingFlatVolume1m(120)
  const short = full.slice(0, 8) // < minBars 5m bars
  const ownWithJunkVolume = full.map((b) => ({ ...b, v: 999 }))

  it('keeps a judgeable series', () => {
    const r = selectRugSignalBars({ series: full, cached: [], own: full, minBars })
    expect(r.source).toBe('series')
    expect(r.bars).toBe(full)
  })

  it('uses own-1m when the series is too short (not only when empty), volume-less', () => {
    const r = selectRugSignalBars({ series: short, cached: [], own: ownWithJunkVolume, minBars })
    expect(r.source).toBe('own')
    expect(r.bars).toHaveLength(120)
    expect(r.bars.every((b) => !('v' in b))).toBe(true)
  })

  it('still uses own-1m when the series is empty', () => {
    const r = selectRugSignalBars({ series: [], cached: [], own: full, minBars })
    expect(r.source).toBe('own')
  })

  it('keeps the short series when the fallback has nothing more', () => {
    const r = selectRugSignalBars({ series: short, cached: [], own: short.slice(0, 3), minBars })
    expect(r.source).toBe('series')
    expect(r.bars).toBe(short)
  })

  it('prefers the 24h cache over own-1m (order unchanged) and keeps its volume', () => {
    const r = selectRugSignalBars({ series: short, cached: full, own: full, minBars })
    expect(r.source).toBe('cache')
    expect(r.bars[0]!.v).toBe(100)
  })

  it('a short cache yields to a longer own-1m series', () => {
    const r = selectRugSignalBars({ series: [], cached: short, own: full, minBars })
    expect(r.source).toBe('own')
  })

  it('none when nothing exists', () => {
    expect(selectRugSignalBars({ series: [], cached: [], own: [], minBars })).toEqual({
      bars: [],
      source: 'none',
    })
  })

  it('own-1m rows cannot feed the volume band (stays unknown → 0)', () => {
    const r = selectRugSignalBars({ series: short, cached: [], own: ownWithJunkVolume, minBars })
    const scored = evaluateRugSignalFrom1m(
      { bars1m: r.bars, mcap: 500_000, liquidityUsd: 5_000, ageHours: 1 },
      DEFAULT_RUG_SIGNAL_THRESHOLDS,
    )
    expect(scored.breakdown.volume).toBe(0)
  })
})

describe('detectRugSignal — shadow row is tagged own for the fallback', () => {
  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    delete process.env.RUG_SIGNAL_ENABLED
    delete process.env.RUG_SIGNAL_MODE
  })

  it('records bars_source=own when the series is short and own-1m is longer', async () => {
    process.env.RUG_SIGNAL_ENABLED = 'true'
    process.env.RUG_SIGNAL_MODE = 'shadow'
    const full = risingFlatVolume1m(120)
    const recorded: Array<Record<string, unknown>> = []
    vi.resetModules()
    vi.doMock('@/utils/db', () => ({ queryOne: vi.fn(async () => null), query: vi.fn() }))
    vi.doMock('@/utils/rug-list/service', () => ({
      isTokenRugged: vi.fn(async () => false),
      markTokenRug: vi.fn(),
    }))
    vi.doMock('@/strategies/token-metrics-history', () => ({
      load1mOhlcv: vi.fn(async () => ohlcvFrom(full.slice(0, 6))),
    }))
    vi.doMock('@/strategies/token-map-chart', () => ({
      getCachedTokenOhlc24h1m: vi.fn(async () => ({ candles: [], source: 'none' })),
      loadOwn1mBars: vi.fn(async () =>
        full.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: 5 })),
      ),
      tokenOhlcToRugBars: (cs: Array<Record<string, number | undefined>>) =>
        cs.map((c) => ({
          t: c.time as number,
          o: c.open as number,
          h: c.high as number,
          l: c.low as number,
          c: c.close as number,
          ...(c.volume != null ? { v: c.volume } : {}),
        })),
    }))
    vi.doMock('@/strategies/rug-signal-shadow', () => ({
      recordRugSignalShadow: vi.fn(async (row: Record<string, unknown>) => {
        recorded.push(row)
      }),
    }))
    const { detectRugSignal } = await import('@/strategies/rug-signal-detect')
    const res = await detectRugSignal({ chain: 'solana', tokenAddress: 'MintOwn1' })
    expect(res.barsSource).toBe('own')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.barsSource).toBe('own')
    expect(recorded[0]!.barsUsed).toBe(120)
  })
})
