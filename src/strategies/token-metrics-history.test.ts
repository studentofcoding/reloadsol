import { describe, expect, it } from 'vitest'
import {
  FIVE_MIN_PER_HOUR,
  SLOTS_PER_HOUR,
  derive5mVolume,
  expandHourRowsToOhlcv,
  filledSlots,
  hourBucketIso,
  hourBucketUtc,
  minuteSlot,
  planSlotWrites,
  type MetricsHourRow,
} from '@/strategies/token-metrics-history'
import { aggregateTo5m, type RugSignalBar } from '@/strategies/rug-signal'

/** 1m bars equivalent to a slot array — the input `aggregateTo5m` would see. */
function barsFromSlots(hourStartSec: number, slots: Array<number | null>): RugSignalBar[] {
  return slots.map((v, i) => ({
    t: hourStartSec + i * 60,
    o: 1,
    h: 1,
    l: 1,
    c: 1,
    ...(v != null ? { v } : {}),
  }))
}

const HOUR = '2026-10-01T12:00:00.000Z'
const HOUR_START_SEC = Date.parse(HOUR) / 1000

describe('hourBucketUtc / minuteSlot — UTC only, 1-based', () => {
  it('floors to the UTC hour', () => {
    expect(hourBucketIso(new Date('2026-10-01T12:34:56.789Z'))).toBe('2026-10-01T12:00:00.000Z')
    expect(hourBucketIso(new Date('2026-10-01T12:00:00.000Z'))).toBe('2026-10-01T12:00:00.000Z')
    expect(hourBucketIso(new Date('2026-10-01T12:59:59.999Z'))).toBe('2026-10-01T12:00:00.000Z')
    expect(hourBucketIso(new Date('2026-10-01T13:00:00.000Z'))).toBe('2026-10-01T13:00:00.000Z')
    expect(hourBucketUtc(new Date('2026-10-02T00:00:30.000Z')).toISOString()).toBe(
      '2026-10-02T00:00:00.000Z',
    )
  })

  it('is 1-based and UTC-derived (E4: DST can never shift it)', () => {
    // minute 0 → slot 1, minute 59 → slot 60
    expect(minuteSlot(new Date('2026-10-01T12:00:00.000Z'))).toBe(1)
    expect(minuteSlot(new Date('2026-10-01T12:59:00.000Z'))).toBe(60)
    // A US DST spring-forward instant: still the UTC minute, never a local one.
    const dst = new Date('2026-03-08T07:30:00.000Z')
    expect(minuteSlot(dst)).toBe(dst.getUTCMinutes() + 1)
    expect(minuteSlot(dst)).toBe(31)
  })
})

describe('planSlotWrites', () => {
  const at = (iso: string, v: number | null) => ({ t: Date.parse(iso) / 1000, v })

  it('buckets by the CANDLE time, not wall-clock (E8: 12:59 written late lands in the 12:00 row)', () => {
    const plans = planSlotWrites([at('2026-10-01T12:59:00.000Z', 5)])
    expect(plans).toHaveLength(1)
    expect(plans[0]!.hourIso).toBe(HOUR)
    expect(plans[0]!.slots).toEqual([{ slot: 60, value: 5 }])
  })

  it('splits a multi-hour backlog into one plan per hour, sorted (E9)', () => {
    const plans = planSlotWrites([
      at('2026-10-01T12:01:00.000Z', 1),
      at('2026-10-01T11:30:00.000Z', 2),
      at('2026-10-01T12:02:00.000Z', 3),
      at('2026-10-01T10:05:00.000Z', 4),
    ])
    expect(plans.map((p) => p.hourIso)).toEqual([
      '2026-10-01T10:00:00.000Z',
      '2026-10-01T11:00:00.000Z',
      '2026-10-01T12:00:00.000Z',
    ])
    expect(plans[2]!.slots.map((s) => s.slot)).toEqual([2, 3])
  })

  it('orders slots and dedupes within a batch, first wins (E5/E7)', () => {
    const plans = planSlotWrites([
      { t: HOUR_START_SEC + 30 * 60, v: 30 },
      { t: HOUR_START_SEC + 12 * 60, v: 12 },
      { t: HOUR_START_SEC + 30 * 60, v: 999 }, // duplicate minute → ignored
    ])
    expect(plans[0]!.slots).toEqual([
      { slot: 13, value: 12 },
      { slot: 31, value: 30 },
    ])
  })

  it('drops non-finite, negative and missing volumes — never writes a zero (E1/E12)', () => {
    const plans = planSlotWrites([
      at('2026-10-01T12:00:00.000Z', Number.NaN),
      at('2026-10-01T12:01:00.000Z', Number.POSITIVE_INFINITY),
      at('2026-10-01T12:02:00.000Z', -1),
      at('2026-10-01T12:03:00.000Z', null),
      at('2026-10-01T12:04:00.000Z', 7),
    ])
    expect(plans[0]!.slots).toEqual([{ slot: 5, value: 7 }])
  })

  it('writes nothing for an empty input (E10)', () => {
    expect(planSlotWrites([])).toEqual([])
  })
})

describe('filledSlots', () => {
  it('counts only finite non-null slots', () => {
    expect(filledSlots({ hour_bucket: HOUR, vol_min: [1, null, 2, undefined as never, 3] })).toBe(3)
    expect(filledSlots({ hour_bucket: HOUR, vol_min: null })).toBe(0)
    expect(filledSlots({ hour_bucket: HOUR, vol_min: [] })).toBe(0)
  })
})

describe('derive5mVolume — invariant 5 (all five minutes or nothing)', () => {
  const row = (slots: Array<number | null>): MetricsHourRow => ({
    hour_bucket: HOUR,
    vol_min: slots,
  })
  const full = (v: number): Array<number | null> =>
    Array.from({ length: SLOTS_PER_HOUR }, () => v)

  it('sums a bucket only when all five minutes are present (E11)', () => {
    const slots = full(10)
    slots[3] = null // minute 3 of the first 5m bucket is missing
    const out = derive5mVolume([row(slots)])
    expect(out).toHaveLength(FIVE_MIN_PER_HOUR)
    expect(out[0]!.volume).toBeNull() // incomplete → NULL, not 40
    expect(out[1]!.volume).toBe(50)
  })

  it('emits one null bucket per empty bucket rather than nothing', () => {
    const out = derive5mVolume([row(Array.from({ length: SLOTS_PER_HOUR }, () => null))])
    expect(out).toHaveLength(FIVE_MIN_PER_HOUR)
    expect(out.every((b) => b.volume === null)).toBe(true)
  })

  it('stamps buckets at 5-minute offsets in UTC seconds', () => {
    const out = derive5mVolume([row(full(1))])
    expect(out[0]!.t).toBe(HOUR_START_SEC)
    expect(out[1]!.t).toBe(HOUR_START_SEC + 300)
    expect(out[11]!.t).toBe(HOUR_START_SEC + 3300)
  })

  it('tolerates a short or missing array (E13)', () => {
    expect(derive5mVolume([{ hour_bucket: HOUR, vol_min: new Array(30).fill(2) }])[6]!.volume)
      .toBeNull()
    expect(derive5mVolume([{ hour_bucket: HOUR, vol_min: null }])).toHaveLength(FIVE_MIN_PER_HOUR)
  })

  it('sorts across hours', () => {
    const out = derive5mVolume([
      { hour_bucket: '2026-10-01T13:00:00.000Z', vol_min: full(1) },
      { hour_bucket: HOUR, vol_min: full(1) },
    ])
    expect(out[0]!.t).toBe(HOUR_START_SEC)
    expect(out[out.length - 1]!.t).toBe(HOUR_START_SEC + 3600 + 3300)
  })
})

describe('differential — derived 5m volume === the shipped aggregateTo5m rule (E25)', () => {
  /** A slot value is "usable" only when finite and >= 0, matching both implementations. */
  function expectedFor(slots: Array<number | null>, bucket: number): number | null {
    const from = bucket * 5
    let sum = 0
    for (let i = from; i < from + 5; i++) {
      const v = slots[i]
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null
      sum += v
    }
    return sum
  }

  it('agrees with aggregateTo5m on random slot arrays', () => {
    let seed = 1234567
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }

    for (let trial = 0; trial < 300; trial++) {
      const slots: Array<number | null> = Array.from({ length: SLOTS_PER_HOUR }, () => {
        const r = rand()
        if (r < 0.35) return null // unobserved
        if (r < 0.4) return 0 // observed zero — must still count as observed
        return Math.round(r * 10_000) / 100
      })

      const derived = derive5mVolume([{ hour_bucket: HOUR, vol_min: slots }])
      const aggregated = aggregateTo5m(barsFromSlots(HOUR_START_SEC, slots))
      const aggByT = new Map(aggregated.map((b) => [b.t, b.v]))

      for (let bucket = 0; bucket < FIVE_MIN_PER_HOUR; bucket++) {
        const t = HOUR_START_SEC + bucket * 300
        const fromAgg = aggByT.get(t)
        // No bucket at all (no bars) and a bucket without v both mean "no usable volume".
        const expected = typeof fromAgg === 'number' ? fromAgg : null
        expect(derived[bucket]!.t).toBe(t)
        expect(derived[bucket]!.volume, `trial ${trial} bucket ${bucket}`).toBe(expected)
        expect(derived[bucket]!.volume).toBe(expectedFor(slots, bucket))
      }
    }
  })

  it('treats an observed zero as data, not as missing', () => {
    const slots: Array<number | null> = Array.from({ length: SLOTS_PER_HOUR }, () => 0)
    const derived = derive5mVolume([{ hour_bucket: HOUR, vol_min: slots }])
    expect(derived[0]!.volume).toBe(0)

    const aggregated = aggregateTo5m(barsFromSlots(HOUR_START_SEC, slots))
    expect(aggregated[0]!.v).toBe(0)
  })
})

describe('token-metrics-history — OHLCV slots', () => {
  it('carries OHLC alongside the volume slot', () => {
    const plans = planSlotWrites([
      { t: Date.parse('2026-10-01T12:05:00Z') / 1000, v: 10, o: 1.5, h: 2.5, l: 1.2, c: 2.0 },
    ])
    expect(plans).toEqual([
      {
        hourIso: '2026-10-01T12:00:00.000Z',
        slots: [{ slot: 6, value: 10, o: 1.5, h: 2.5, l: 1.2, c: 2.0 }],
      },
    ])
  })

  it('keeps an absent price absent, and still gates the slot on volume', () => {
    const lastMinute = Date.parse('2026-10-01T12:59:00Z') / 1000

    // A volume-only candle (e.g. a rolling-window source) writes no prices at all.
    const plans = planSlotWrites([{ t: lastMinute, v: 5 }])
    expect(plans[0]!.slots[0]).toEqual({ slot: 60, value: 5 })

    // A candle with prices but no volume is dropped entirely — never a fabricated 0-volume bar.
    expect(planSlotWrites([{ t: lastMinute, o: 1, h: 2, l: 0.5, c: 1.5 }])).toEqual([])
  })

  it('drops non-finite and negative prices without dropping the volume slot', () => {
    const plans = planSlotWrites([
      {
        t: Date.parse('2026-10-01T12:59:00Z') / 1000,
        v: 5,
        o: Number.NaN,
        h: -1,
        l: 1.2,
        c: Number.POSITIVE_INFINITY,
      },
    ])
    expect(plans[0]!.slots[0]).toEqual({ slot: 60, value: 5, l: 1.2 })
  })
})

describe('token-metrics-history — OHLCV expansion', () => {
  const base = Date.parse('2026-10-01T12:00:00Z') / 1000
  const row = (over: Partial<MetricsHourRow>): MetricsHourRow => ({
    hour_bucket: '2026-10-01T12:00:00.000Z',
    vol_min: Array(SLOTS_PER_HOUR).fill(null),
    ...over,
  })
  const slots = (entries: Array<[number, number]>): Array<number | null> => {
    const arr = Array(SLOTS_PER_HOUR).fill(null)
    for (const [slot, value] of entries) arr[slot] = value
    return arr
  }

  it('emits a candle per observed minute, with absent fields as null (never 0)', () => {
    const rows = [
      row({
        vol_min: slots([[0, 10], [2, 30]]),
        o_min: slots([[0, 1.5], [2, 3.5]]),
        h_min: slots([[0, 2], [2, 4]]),
      }),
    ]
    expect(expandHourRowsToOhlcv(rows)).toEqual([
      { t: base, o: 1.5, h: 2, l: null, c: null, v: 10 },
      { t: base + 120, o: 3.5, h: 4, l: null, c: null, v: 30 },
    ])
  })

  it('still emits a minute that has only a price, and skips minutes with nothing', () => {
    const rows = [row({ c_min: slots([[5, 9.9]]) })]
    expect(expandHourRowsToOhlcv(rows)).toEqual([
      { t: base + 300, o: null, h: null, l: null, c: 9.9, v: null },
    ])
  })

  it('tolerates pre-migration rows whose OHLC arrays are NULL', () => {
    const rows = [row({ vol_min: slots([[0, 10]]) })]
    expect(expandHourRowsToOhlcv(rows)).toEqual([
      { t: base, o: null, h: null, l: null, c: null, v: 10 },
    ])
  })

  it('orders ascending across hour rows given out of order', () => {
    const later: MetricsHourRow = {
      hour_bucket: '2026-10-01T13:00:00.000Z',
      vol_min: slots([[0, 1]]),
    }
    const earlier = row({ vol_min: slots([[59, 2]]) })
    expect(expandHourRowsToOhlcv([later, earlier]).map((c) => c.t)).toEqual([
      base + 3540,
      base + 3600,
    ])
  })
})
