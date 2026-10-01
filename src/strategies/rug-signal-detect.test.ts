import { describe, expect, it } from 'vitest'
import {
  ohlcvMinutesToRugBars,
  rugSignalLookbackMs,
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
