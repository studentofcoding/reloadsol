import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RUG_SIGNAL_THRESHOLDS,
  RUG_SIGNAL_MAX_SCORE,
  RUG_SIGNAL_WEIGHTS,
  aggregateTo5m,
  evaluateRugSignal,
  evaluateRugSignalFrom1m,
  isRugSignalEnabled,
  resolveRugSignalThresholds,
  rugSignalMode,
  type RugSignalBar,
} from '@/strategies/rug-signal'

function bar5m(
  i: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v?: number,
): RugSignalBar {
  // Base is a multiple of 300 so 1m bars bucket cleanly in evaluateRugSignalFrom1m.
  return { t: 1_700_000_100 + i * 300, o, h, l, c, ...(v != null ? { v } : {}) }
}

/**
 * The screenshots: flat thin-volume base, then a staircase up in small steps with
 * pauses. 16 green (+4.2%) and 4 pause bars (−0.5%) → bullish 0.80, mean green gain
 * 0.042, first-close→last-close gain ~+82%, near-identical tiny upper wicks, flat
 * ~3k volume.
 */
function staircaseBars(): RugSignalBar[] {
  const shape = [1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0]
  const out: RugSignalBar[] = []
  let price = 0.1
  for (let i = 0; i < shape.length; i++) {
    const o = price
    const c = shape[i] === 1 ? o * 1.042 : o * 0.995
    out.push(
      bar5m(
        i,
        o,
        Math.max(o, c) * 1.0005,
        Math.min(o, c) * 0.9995,
        c,
        3000 + (i % 3),
      ),
    )
    price = c
  }
  return out
}

/** Same +140% move, but organic: volume expands with price, tall alternating wicks. */
function organicPumpBars(): RugSignalBar[] {
  const out: RugSignalBar[] = []
  let price = 0.1
  for (let i = 0; i < 20; i++) {
    const o = price
    const c = o * 1.045
    out.push(
      bar5m(
        i,
        o,
        Math.max(o, c) * (i % 2 === 0 ? 1.4 : 1.01),
        Math.min(o, c) * (i % 2 === 0 ? 0.98 : 0.999),
        c,
        2000 + i * 900,
      ),
    )
    price = c
  }
  return out
}

function healthyBars(): RugSignalBar[] {
  const out: RugSignalBar[] = []
  let price = 0.1
  for (let i = 0; i < 20; i++) {
    const o = price
    const c = o * (i % 2 === 0 ? 1.002 : 0.998)
    out.push(
      bar5m(i, o, Math.max(o, c) * 1.001, Math.min(o, c) * 0.999, c, 5000 + (i % 2)),
    )
    price = c
  }
  return out
}

const YOUNG = 3
const THIN_LIQ = 30_000 // 1.5% of a $2M mcap → full liquidity points

describe('aggregateTo5m', () => {
  it('buckets 1m bars on floor(t/300) and sums volume', () => {
    const bars1m: RugSignalBar[] = Array.from({ length: 10 }, (_, i) => ({
      t: 600 + i * 60,
      o: 1 + i * 0.1,
      h: 1.2 + i * 0.1,
      l: 0.9 + i * 0.1,
      c: 1.1 + i * 0.1,
      v: 10,
    }))
    const out = aggregateTo5m(bars1m)
    expect(out).toHaveLength(2)
    expect(out[0]!.t).toBe(600)
    expect(out[0]!.o).toBeCloseTo(1, 6)
    expect(out[0]!.c).toBeCloseTo(1.5, 6)
    expect(out[0]!.h).toBeCloseTo(1.6, 6)
    expect(out[0]!.l).toBeCloseTo(0.9, 6)
    expect(out[0]!.v).toBe(50)
    expect(out[1]!.t).toBe(900)
  })

  it('drops volume for a bucket when any bar lacks it', () => {
    const out = aggregateTo5m([
      { t: 600, o: 1, h: 1, l: 1, c: 1, v: 10 },
      { t: 660, o: 1, h: 1, l: 1, c: 1 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.v).toBeUndefined()
  })
})

describe('evaluateRugSignal — staircase', () => {
  it('labels staircase + flat volume + liq/mcap < 5% as rug (40+30+17 = 87)', () => {
    const r = evaluateRugSignal({
      bars: staircaseBars(),
      mcap: 2_000_000,
      liquidityUsd: THIN_LIQ, // 1.5% → liquidity risk 0.85
      ageHours: YOUNG,
    })
    expect(r.skipped).toBe(false)
    expect(r.breakdown.staircase).toBe(40)
    expect(r.breakdown.volume).toBe(30)
    expect(r.breakdown.liquidity).toBe(17)
    expect(r.breakdown.dump).toBe(0)
    expect(r.score).toBe(87)
    expect(r.isRug).toBe(true)
    expect(r.reasons.some((x) => x.includes('rug staircase'))).toBe(true)
  })

  it('still clears the threshold at 4% liquidity (40+30+12 = 82)', () => {
    const r = evaluateRugSignal({
      bars: staircaseBars(),
      mcap: 2_000_000,
      liquidityUsd: 80_000, // 4% → risk 0.6
      ageHours: YOUNG,
    })
    expect(r.breakdown.liquidity).toBe(12)
    expect(r.score).toBe(82)
    expect(r.isRug).toBe(true)
  })

  it('lands exactly on the threshold at 5% liquidity (40+30+10 = 80)', () => {
    const r = evaluateRugSignal({
      bars: staircaseBars(),
      mcap: 2_000_000,
      liquidityUsd: 100_000, // 5% → risk 0.5
      ageHours: YOUNG,
    })
    expect(r.breakdown.liquidity).toBe(10)
    expect(r.score).toBe(80)
    expect(r.isRug).toBe(true)
  })

  it('falls to 70 and stays unlabeled once liquidity is deep (≥10%)', () => {
    const r = evaluateRugSignal({
      bars: staircaseBars(),
      mcap: 2_000_000,
      liquidityUsd: 300_000, // 15% → past the safe anchor, risk 0
      ageHours: YOUNG,
    })
    expect(r.breakdown.liquidity).toBe(0)
    expect(r.score).toBe(70)
    expect(r.isRug).toBe(false)
  })

  it('stays under when the threshold is set above the ramp max', () => {
    const r = evaluateRugSignal(
      {
        bars: staircaseBars(),
        mcap: 2_000_000,
        liquidityUsd: THIN_LIQ,
        ageHours: YOUNG,
      },
      { threshold: 88 },
    )
    expect(r.score).toBe(87)
    expect(r.isRug).toBe(false)
  })

  it('does not trip up_only_10-style strictness on the pause bars', () => {
    const r = evaluateRugSignal(
      {
        bars: staircaseBars(),
        mcap: 2_000_000,
        liquidityUsd: THIN_LIQ,
        ageHours: YOUNG,
      },
      { threshold: 120 },
    )
    // 4 of 20 bars are not green, yet the staircase still scores full — the exact
    // shape the reactive `up_only_10` rule misses.
    const stair = r.components.find((c) => c.id === 'staircase')!
    expect(stair.conditions!.filter((c) => c.met)).toHaveLength(4)
    expect(stair.points).toBe(40)
  })
})

describe('evaluateRugSignal — negatives', () => {
  it('rejects an organic pump that expands volume', () => {
    const r = evaluateRugSignal({
      bars: organicPumpBars(),
      mcap: 2_000_000,
      liquidityUsd: 300_000,
      ageHours: YOUNG,
    })
    // Volume grew faster than price and stayed dispersed → the band bottoms out.
    expect(r.breakdown.volume).toBe(0)
    expect(r.score).toBeLessThan(80)
    expect(r.isRug).toBe(false)
  })

  it('scores a flat healthy token near zero', () => {
    const r = evaluateRugSignal({
      bars: healthyBars(),
      mcap: 2_000_000,
      liquidityUsd: 300_000,
      ageHours: YOUNG,
    })
    expect(r.score).toBeLessThan(40)
    expect(r.isRug).toBe(false)
  })

  it('skips an old, liquid token even when the shape matches', () => {
    const r = evaluateRugSignal({
      bars: staircaseBars(),
      mcap: 2_000_000,
      liquidityUsd: 500_000,
      ageHours: 100,
    })
    expect(r.skipped).toBe(true)
    expect(r.isRug).toBe(false)
    expect(r.skipReason).toContain('age')
  })

  it('never assumes unknown liquidity is safe', () => {
    const r = evaluateRugSignal({ bars: staircaseBars(), mcap: 2_000_000 })
    const liq = r.components.find((c) => c.id === 'liquidity')!
    expect(liq.note).toBe('liquidity unknown')
    expect(liq.points).toBe(0)
    expect(r.breakdown.volume).toBe(30) // bars had volume; only liquidity is unknown
  })

  it('leaves the dump component as confirmation, not a standalone trip', () => {
    const bars = [
      bar5m(0, 1, 1.02, 0.99, 1),
      bar5m(1, 1, 1.01, 0.98, 0.99),
      bar5m(2, 0.99, 1, 0.54, 0.55), // −45% bar
      bar5m(3, 0.55, 0.56, 0.54, 0.55),
    ]
    const r = evaluateRugSignal({ bars, mcap: 2_000_000, liquidityUsd: 300_000 })
    expect(r.breakdown.dump).toBe(5) // 1 of 2 dump conditions × 10
    expect(r.isRug).toBe(false)
  })
})

describe('volume band', () => {
  it('runs 0 (safest) → 30 (riskiest) on flat volume under a ramp', () => {
    const r = evaluateRugSignal({
      bars: staircaseBars(),
      mcap: 2_000_000,
      liquidityUsd: THIN_LIQ,
    })
    const vol = r.components.find((c) => c.id === 'volume')!
    expect(vol.max).toBe(30)
    expect(vol.points).toBe(30)
    expect(vol.measures!.map((m) => m.id)).toEqual(['expansion', 'dispersion'])
    expect(vol.measures!.find((m) => m.id === 'expansion')!.risk).toBeCloseTo(1, 5)
  })

  it('scores 0 when price is not rising, instead of punishing dispersion', () => {
    const r = evaluateRugSignal({ bars: healthyBars(), mcap: 2_000_000 })
    const vol = r.components.find((c) => c.id === 'volume')!
    expect(vol.note).toBe('price not rising')
    expect(vol.points).toBe(0)
  })

  it('is strictly higher for flatter volume on the same ramp', () => {
    const ramp = staircaseBars()
    const flat = evaluateRugSignal({ bars: ramp, mcap: 2_000_000 }).breakdown.volume
    const expanding = evaluateRugSignal({
      bars: ramp.map((b, i, all) => ({
        ...b,
        v: (b.v ?? 0) * (1 + (i / all.length) * 3),
      })),
      mcap: 2_000_000,
    }).breakdown.volume
    expect(flat).toBeGreaterThan(expanding)
  })
})

describe('evaluateRugSignalFrom1m', () => {
  it('aggregates 1m bars before scoring', () => {
    const bars1m: RugSignalBar[] = staircaseBars().flatMap((b) =>
      Array.from({ length: 5 }, (_, k) => ({
        t: b.t + k * 60,
        o: b.o,
        h: b.h,
        l: b.l,
        c: b.c,
        v: (b.v ?? 0) / 5,
      })),
    )
    const r = evaluateRugSignalFrom1m({
      bars1m,
      mcap: 2_000_000,
      liquidityUsd: THIN_LIQ,
      ageHours: YOUNG,
    })
    expect(r.isRug).toBe(true)
  })
})

describe('config', () => {
  it('defaults the threshold to 80, below the 90 a no-dump ramp can reach', () => {
    expect(DEFAULT_RUG_SIGNAL_THRESHOLDS.threshold).toBe(80)
    expect(DEFAULT_RUG_SIGNAL_THRESHOLDS.liqSafeRatio).toBe(0.1)
    expect(DEFAULT_RUG_SIGNAL_THRESHOLDS.volCvSafe).toBe(0.35)
    expect(DEFAULT_RUG_SIGNAL_THRESHOLDS.volExpansionWeight).toBe(0.5)
  })

  it('weights sum to a 0..100 scale (A40 B30 C20 D10)', () => {
    expect(RUG_SIGNAL_WEIGHTS).toEqual({
      staircase: 40,
      volume: 30,
      liquidity: 20,
      dump: 10,
    })
    expect(RUG_SIGNAL_MAX_SCORE).toBe(100)
    expect(RUG_SIGNAL_MAX_SCORE).toBe(
      Object.values(RUG_SIGNAL_WEIGHTS).reduce((a, b) => a + b, 0),
    )
  })

  it('reads overrides from env and ignores junk', () => {
    const th = resolveRugSignalThresholds({
      RUG_SIG_THRESHOLD: '55',
      RUG_SIG_STAIR_BULLISH: 'nope',
      RUG_SIG_WINDOW: '30',
    })
    expect(th.threshold).toBe(55)
    expect(th.stairBullishMin).toBe(
      DEFAULT_RUG_SIGNAL_THRESHOLDS.stairBullishMin,
    )
    expect(th.windowBars).toBe(30)
  })

  it('ships off by default, enforce when enabled, shadow on kill switch', () => {
    expect(isRugSignalEnabled({})).toBe(false)
    expect(isRugSignalEnabled({ RUG_SIGNAL_ENABLED: '1' })).toBe(true)
    expect(rugSignalMode({})).toBe('enforce')
    expect(rugSignalMode({ RUG_SIGNAL_MODE: 'shadow' })).toBe('shadow')
    expect(
      rugSignalMode({ RUG_SIGNAL_MODE: 'enforce', RUG_SIGNAL_KILL_SWITCH: '1' }),
    ).toBe('shadow')
  })
})
