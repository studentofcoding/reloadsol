import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OHLC_RUG_THRESHOLDS,
  evaluateOhlcRugRules,
  takeLastOhlcBars,
  type OhlcRugBar,
} from '@/strategies/ohlc-rug-rules'

function bar(
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v?: number,
): OhlcRugBar {
  return { t, o, h, l, c, ...(v != null ? { v } : {}) }
}

describe('takeLastOhlcBars', () => {
  it('keeps all when under limit', () => {
    const bars = [bar(1, 1, 1, 1, 1), bar(2, 1, 1, 1, 1)]
    expect(takeLastOhlcBars(bars, 10)).toHaveLength(2)
  })

  it('takes last N', () => {
    const bars = Array.from({ length: 15 }, (_, i) => bar(i, 1, 1, 1, 1))
    const last = takeLastOhlcBars(bars, 10)
    expect(last).toHaveLength(10)
    expect(last[0]!.t).toBe(5)
  })
})

describe('evaluateOhlcRugRules', () => {
  it('does not trip dump at exactly under 40%', () => {
    // 100 -> 60.1 = 39.9% dump
    const r = evaluateOhlcRugRules([bar(1, 100, 100, 60, 60.1), bar(2, 60.1, 61, 60, 60.1)])
    const dump = r.hits.find((h) => h.id === 'dump_10m')!
    expect(dump.passed).toBe(false)
    expect(dump.value!).toBeLessThan(DEFAULT_OHLC_RUG_THRESHOLDS.dumpPct)
  })

  it('trips dump at ≥40%', () => {
    const r = evaluateOhlcRugRules([bar(1, 100, 100, 50, 100), bar(2, 60, 60, 50, 60)])
    const dump = r.hits.find((h) => h.id === 'dump_10m')!
    expect(dump.value).toBeCloseTo(0.4, 5)
    expect(dump.passed).toBe(true)
    expect(r.trip).toBe(true)
  })

  it('uses remaining bars when n < 10', () => {
    const r = evaluateOhlcRugRules([bar(1, 10, 10, 5, 10), bar(2, 5, 5, 4, 5)])
    expect(r.features.n).toBe(2)
    expect(r.hits.find((h) => h.id === 'dump_10m')!.passed).toBe(true)
  })

  it('skips volume_death when volume missing', () => {
    const r = evaluateOhlcRugRules([
      bar(1, 1, 1.2, 0.9, 1),
      bar(2, 1, 1.1, 0.95, 1),
    ])
    const vol = r.hits.find((h) => h.id === 'volume_death')!
    expect(vol.skipped).toBe(true)
    expect(vol.passed).toBe(false)
  })

  it('trips volume_death when last vol collapses', () => {
    const r = evaluateOhlcRugRules([
      bar(1, 1, 1, 1, 1, 100),
      bar(2, 1, 1, 1, 1, 100),
      bar(3, 1, 1, 1, 1, 10),
    ])
    const vol = r.hits.find((h) => h.id === 'volume_death')!
    expect(vol.skipped).toBeFalsy()
    expect(vol.value).toBeCloseTo(0.1, 5)
    expect(vol.passed).toBe(true)
  })

  it('trips wick_reject on high avg upper wick with ≥2 bars', () => {
    // Tall upper wicks: o=c=1, h=2, l=1 → wick = 1/1 = 1.0
    const r = evaluateOhlcRugRules([
      bar(1, 1, 2, 1, 1, 50),
      bar(2, 1, 2, 1, 1, 50),
    ])
    const wick = r.hits.find((h) => h.id === 'wick_reject')!
    expect(wick.value).toBeCloseTo(1, 5)
    expect(wick.passed).toBe(true)
  })
})
