import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OHLC_RUG_THRESHOLDS,
  evaluateOhlcRugRules,
  isOhlcWindowStale,
  ohlcNewestBarAgeSec,
  resolveOhlcRugMaxBarAgeSec,
  resolveOhlcRugWindow,
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

describe('resolveOhlcRugWindow', () => {
  const cached = [bar(1, 1, 1, 1, 1), bar(2, 1, 1, 1, 1)]
  const own = Array.from({ length: 12 }, (_, i) => bar(100 + i, 2, 2, 2, 2))

  it('prefers canonical bars over own-1m', () => {
    const picked = resolveOhlcRugWindow({
      cached,
      cachedSource: 'gmgn',
      own,
      fallbackOwn1m: true,
    })
    expect(picked.source).toBe('gmgn')
    expect(picked.bars).toHaveLength(2)
    expect(picked.bars[0]!.t).toBe(1)
  })

  it('fills an empty canonical window from the last own-1m bars', () => {
    const picked = resolveOhlcRugWindow({
      cached: [],
      cachedSource: 'none',
      own,
      n: 10,
      fallbackOwn1m: true,
    })
    expect(picked.source).toBe('own-1m')
    expect(picked.bars).toHaveLength(10)
    expect(picked.bars[0]!.t).toBe(102)
  })

  it('stays empty when own-1m fallback is off', () => {
    const picked = resolveOhlcRugWindow({
      cached: [],
      cachedSource: 'none',
      own,
      fallbackOwn1m: false,
    })
    expect(picked.bars).toHaveLength(0)
    expect(picked.source).toBe('none')
  })

  it('stays empty when storage has no bars', () => {
    const picked = resolveOhlcRugWindow({
      cached: [],
      cachedSource: 'none',
      own: [],
      fallbackOwn1m: true,
    })
    expect(picked.bars).toHaveLength(0)
    expect(picked.source).toBe('none')
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

  it('skips up_only_10 when n < 10', () => {
    const greens = Array.from({ length: 5 }, (_, i) =>
      bar(i + 1, 1, 1.2, 1, 1.1, 10),
    )
    const r = evaluateOhlcRugRules(greens)
    const up = r.hits.find((h) => h.id === 'up_only_10')!
    expect(up.skipped).toBe(true)
    expect(up.passed).toBe(false)
    expect(r.features.upOnlyCount).toBe(5)
  })

  it('trips up_only_10 when all 10 bars are green', () => {
    const greens = Array.from({ length: 10 }, (_, i) =>
      bar(i + 1, 1 + i * 0.1, 2 + i * 0.1, 1 + i * 0.1, 1.05 + i * 0.1, 10),
    )
    const r = evaluateOhlcRugRules(greens)
    const up = r.hits.find((h) => h.id === 'up_only_10')!
    expect(up.skipped).toBeFalsy()
    expect(up.passed).toBe(true)
    expect(up.value).toBe(10)
    expect(r.trip).toBe(true)
  })

  it('does not trip up_only_10 when one of 10 is not green', () => {
    const bars = Array.from({ length: 10 }, (_, i) =>
      i === 5
        ? bar(i + 1, 1.1, 1.1, 1, 1, 10) // red: c < o
        : bar(i + 1, 1, 1.2, 1, 1.1, 10),
    )
    const r = evaluateOhlcRugRules(bars)
    const up = r.hits.find((h) => h.id === 'up_only_10')!
    expect(up.passed).toBe(false)
    expect(up.value).toBe(9)
  })
})

describe('OHLC recency guard', () => {
  const NOW = 1_800_000_000
  const fresh = (count: number, lastAge = 30): OhlcRugBar[] =>
    Array.from({ length: count }, (_, i) =>
      bar(NOW - lastAge - (count - 1 - i) * 60, 1, 1, 1, 1),
    )

  it('resolveOhlcRugMaxBarAgeSec: default 180, env override, 0 disables, junk → default', () => {
    expect(resolveOhlcRugMaxBarAgeSec({})).toBe(180)
    expect(resolveOhlcRugMaxBarAgeSec({ OHLC_RUG_MAX_BAR_AGE_SEC: '90' })).toBe(90)
    expect(resolveOhlcRugMaxBarAgeSec({ OHLC_RUG_MAX_BAR_AGE_SEC: '0' })).toBe(0)
    expect(resolveOhlcRugMaxBarAgeSec({ OHLC_RUG_MAX_BAR_AGE_SEC: 'abc' })).toBe(180)
    expect(resolveOhlcRugMaxBarAgeSec({ OHLC_RUG_MAX_BAR_AGE_SEC: '-5' })).toBe(180)
  })

  it('isOhlcWindowStale compares the newest bar to now', () => {
    expect(isOhlcWindowStale(fresh(3, 30), NOW, 180)).toBe(false)
    expect(isOhlcWindowStale(fresh(3, 181), NOW, 180)).toBe(true)
    expect(isOhlcWindowStale(fresh(3, 9999), NOW, 0)).toBe(false)
    expect(ohlcNewestBarAgeSec([], NOW)).toBeNull()
  })

  it('takeLastOhlcBars without opts never drops (as-of callers unchanged)', () => {
    expect(takeLastOhlcBars(fresh(3, 99999), 10)).toHaveLength(3)
  })

  it('takeLastOhlcBars with maxAgeSec returns [] for a stale series', () => {
    expect(takeLastOhlcBars(fresh(12, 600), 10, { nowSec: NOW, maxAgeSec: 180 })).toEqual([])
    expect(takeLastOhlcBars(fresh(12, 30), 10, { nowSec: NOW, maxAgeSec: 180 })).toHaveLength(10)
  })

  it('stale canonical + no fallback → stale, not bars', () => {
    const picked = resolveOhlcRugWindow({
      cached: fresh(10, 3600),
      cachedSource: 'gmgn-stale',
      nowSec: NOW,
      maxAgeSec: 180,
    })
    expect(picked).toEqual({ bars: [], source: 'stale' })
  })

  it('stale canonical is replaced by fresh own-1m under fallback', () => {
    const picked = resolveOhlcRugWindow({
      cached: fresh(10, 3600),
      cachedSource: 'gmgn',
      own: fresh(5, 20),
      fallbackOwn1m: true,
      nowSec: NOW,
      maxAgeSec: 180,
    })
    expect(picked.source).toBe('own-1m')
    expect(picked.bars).toHaveLength(5)
  })

  it('stale canonical and stale own-1m → stale', () => {
    const picked = resolveOhlcRugWindow({
      cached: fresh(10, 3600),
      cachedSource: 'gmgn',
      own: fresh(5, 3000),
      fallbackOwn1m: true,
      nowSec: NOW,
      maxAgeSec: 180,
    })
    expect(picked).toEqual({ bars: [], source: 'stale' })
  })

  it('nothing at all → none (not stale)', () => {
    expect(
      resolveOhlcRugWindow({ cached: [], cachedSource: 'none', nowSec: NOW, maxAgeSec: 180 }),
    ).toEqual({ bars: [], source: 'none' })
  })

  it('maxAgeSec 0 keeps the legacy behavior', () => {
    const picked = resolveOhlcRugWindow({
      cached: fresh(10, 3600),
      cachedSource: 'gmgn',
      nowSec: NOW,
      maxAgeSec: 0,
    })
    expect(picked.source).toBe('gmgn')
    expect(picked.bars).toHaveLength(10)
  })
})
