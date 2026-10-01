import { describe, expect, it } from 'vitest'
import {
  COPY_BAR_LIMIT,
  COPY_RESOLUTION_SECONDS,
  assertCadenceCoversWindow,
  cadenceCoversWindow,
  clipCandlesToWindow,
  copyWindowSeconds,
  mapWithConcurrency,
  planCopyTargets,
  toCandleVolumes,
} from '@/strategies/token-metrics-copier'
import { planSlotWrites } from '@/strategies/token-metrics-history'

const NOW = new Date('2026-10-01T12:00:00Z')
const nowSec = Math.floor(NOW.getTime() / 1000)
const HOUR = 3600

function coverage(oldestSec: number, newestSec: number) {
  return { oldest: oldestSec, newest: newestSec }
}

describe('metrics copier — window guard', () => {
  it('derives the window from bars x resolution', () => {
    expect(copyWindowSeconds()).toBe(COPY_BAR_LIMIT * COPY_RESOLUTION_SECONDS)
    expect(copyWindowSeconds(501, 60)).toBe(30060)
    expect(copyWindowSeconds(100, 60)).toBe(6000)
  })

  it('falls back to the default window on nonsense rather than collapsing to zero', () => {
    // A zero window would make every cadence "too long" and silently disable the copier.
    expect(copyWindowSeconds(0, 0)).toBe(COPY_BAR_LIMIT * COPY_RESOLUTION_SECONDS)
    expect(copyWindowSeconds(-5, -1)).toBe(COPY_BAR_LIMIT * COPY_RESOLUTION_SECONDS)
    expect(copyWindowSeconds(Number.NaN, Number.NaN)).toBe(
      COPY_BAR_LIMIT * COPY_RESOLUTION_SECONDS,
    )
  })

  it('accepts any cadence shorter than the window', () => {
    expect(cadenceCoversWindow(15 * 60)).toBe(true) // 15 min, the recommended default
    expect(cadenceCoversWindow(6 * HOUR)).toBe(true)
  })

  it('rejects a cadence at or beyond the window — the permanent-holes case', () => {
    expect(cadenceCoversWindow(copyWindowSeconds())).toBe(false) // exactly equal
    expect(cadenceCoversWindow(copyWindowSeconds() + 1)).toBe(false)
    expect(cadenceCoversWindow(24 * HOUR)).toBe(false) // a daily sweep would hole the series
  })

  it('treats a disabled cadence as safe', () => {
    expect(cadenceCoversWindow(0)).toBe(true)
    expect(cadenceCoversWindow(Number.NaN)).toBe(true)
  })

  it('throws with the window in the message when a cadence would lose minutes', () => {
    expect(() => assertCadenceCoversWindow(15 * 60)).not.toThrow()
    expect(() => assertCadenceCoversWindow(24 * HOUR)).toThrow(/exceeds/)
    expect(() => assertCadenceCoversWindow(24 * HOUR)).toThrow(/30060/)
  })
})

describe('metrics copier — copy plan', () => {
  it('fetches everything when nothing is cached', () => {
    const plan = planCopyTargets({
      watchMints: ['A', 'B'],
      cached: new Map(),
      now: NOW,
      lookbackMinutes: 240,
      maxStalenessMinutes: 30,
    })
    expect(plan).toEqual({ fromCache: [], fetch: ['A', 'B'] })
  })

  it('skips the vendor call only when the cache is fresh AND reaches back over the window', () => {
    const plan = planCopyTargets({
      watchMints: ['COVERED'],
      cached: new Map([['COVERED', coverage(nowSec - 6 * HOUR, nowSec - 60)]]),
      now: NOW,
      lookbackMinutes: 240, // needs 4h back; 6h covers it
      maxStalenessMinutes: 30,
    })
    expect(plan.fromCache).toEqual(['COVERED'])
    expect(plan.fetch).toEqual([])
  })

  it('still copies a stale cache for its free minutes, and fetches the gap', () => {
    const plan = planCopyTargets({
      watchMints: ['STALE'],
      // Reaches back far enough, but the newest bar is 2h old → recent minutes missing.
      cached: new Map([['STALE', coverage(nowSec - 10 * HOUR, nowSec - 2 * HOUR)]]),
      now: NOW,
      lookbackMinutes: 240,
      maxStalenessMinutes: 30,
    })
    expect(plan.fromCache).toEqual(['STALE'])
    expect(plan.fetch).toEqual(['STALE'])
  })

  it('still copies a fresh cache that does not reach back far enough, and fetches', () => {
    const plan = planCopyTargets({
      watchMints: ['SHORT'],
      // Fresh, but only 30 min of history when the window needs 4h.
      cached: new Map([['SHORT', coverage(nowSec - 30 * 60, nowSec - 30)]]),
      now: NOW,
      lookbackMinutes: 240,
      maxStalenessMinutes: 30,
    })
    expect(plan.fromCache).toEqual(['SHORT'])
    expect(plan.fetch).toEqual(['SHORT'])
  })

  it('handles a mixed set, deduping and normalising the watch list', () => {
    const plan = planCopyTargets({
      watchMints: [' A ', 'A', 'B', '', '   ', 'C'],
      cached: new Map([
        ['A', coverage(nowSec - 6 * HOUR, nowSec - 30)],
        ['B', coverage(nowSec - 10 * HOUR, nowSec - 2 * HOUR)],
      ]),
      now: NOW,
      lookbackMinutes: 240,
      maxStalenessMinutes: 30,
    })
    expect(plan.fromCache).toEqual(['A', 'B'])
    expect(plan.fetch).toEqual(['B', 'C'])
  })

  it('returns empty lists for an empty watch set', () => {
    const plan = planCopyTargets({
      watchMints: [],
      cached: {},
      now: NOW,
      lookbackMinutes: 240,
      maxStalenessMinutes: 30,
    })
    expect(plan).toEqual({ fromCache: [], fetch: [] })
  })
})

describe('metrics copier — bounded concurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    const out = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms))
      return ms
    })
    expect(out).toEqual([30, 10, 20])
  })

  it('never exceeds the concurrency cap', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency([...Array(12).keys()], 3, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return true
    })
    expect(peak).toBe(3)
  })

  it('turns a throwing item into null instead of aborting the sweep', async () => {
    const out = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom')
      return n
    })
    expect(out).toEqual([1, null, 3])
  })

  it('degrades nonsense concurrency to serial and handles an empty list', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency([1, 2, 3], 0, async (n) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 2))
      inFlight--
      return n
    })
    expect(peak).toBe(1)
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([])
  })
})

describe('metrics copier — window clip', () => {
  const WINDOW = COPY_BAR_LIMIT * COPY_RESOLUTION_SECONDS

  it('drops candles older than the lane window', () => {
    const out = clipCandlesToWindow(
      [
        { t: nowSec - WINDOW - 3600, v: 5 },
        { t: nowSec - 600, v: 7 },
      ],
      { now: NOW, windowSeconds: WINDOW },
    )
    expect(out).toEqual([{ t: nowSec - 600, v: 7 }])
  })

  it('drops the years-old bars a barely-traded token returns', () => {
    // Measured on prod: 501 *traded* minutes reached back to 2024 for a dead token.
    const yearsAgo = Date.parse('2024-09-16T14:00:00Z') / 1000
    const out = clipCandlesToWindow(
      [
        { t: yearsAgo, v: 1 },
        { t: nowSec - 60, v: 2 },
      ],
      { now: NOW, windowSeconds: WINDOW },
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.v).toBe(2)
  })

  it('keeps both boundaries and the current minute, drops the far future', () => {
    const out = clipCandlesToWindow(
      [
        { t: nowSec - WINDOW - 120, v: 1 }, // exactly the past bound (slack 120)
        { t: nowSec, v: 2 }, // now, inside slack
        { t: nowSec + 120, v: 3 }, // exactly the future bound
        { t: nowSec + 121, v: 4 }, // beyond it
      ],
      { now: NOW, windowSeconds: WINDOW },
    )
    expect(out.map((c) => c.v)).toEqual([1, 2, 3])
  })

  it('falls back to the default window on nonsense and drops bad timestamps', () => {
    const out = clipCandlesToWindow(
      [
        { t: Number.NaN, v: 1 },
        { t: nowSec - 60, v: 2 },
      ],
      { now: NOW, windowSeconds: 0 },
    )
    expect(out).toEqual([{ t: nowSec - 60, v: 2 }])
  })
})

describe('metrics copier — candle mapping', () => {
  it('renames cache bars to the writer shape and drops unusable timestamps', () => {
    const candles = toCandleVolumes([
      { time: 1790751960, volume: 12.5 },
      { time: 1790752020 }, // no volume → dropped later by planSlotWrites, not here
      { time: Number.NaN, volume: 5 },
    ])
    expect(candles).toEqual([
      { t: 1790751960, v: 12.5 },
      { t: 1790752020, v: undefined },
    ])
  })

  it('feeds the writer so cached minutes land in the right slots', () => {
    // 12:59 and 13:00 UTC must land in different hour rows, slots 60 and 1.
    const candles = toCandleVolumes([
      { time: Date.parse('2026-10-01T12:59:00Z') / 1000, volume: 7 },
      { time: Date.parse('2026-10-01T13:00:00Z') / 1000, volume: 9 },
    ])
    const plans = planSlotWrites(candles)
    expect(plans).toEqual([
      { hourIso: '2026-10-01T12:00:00.000Z', slots: [{ slot: 60, value: 7 }] },
      { hourIso: '2026-10-01T13:00:00.000Z', slots: [{ slot: 1, value: 9 }] },
    ])
  })
})

describe('metrics copier — OHLC carried through', () => {
  it('maps the cache bar\'s whole candle, not just the volume', () => {
    const candles = toCandleVolumes([
      { time: 1790751960, open: 1.5, high: 2.5, low: 1.2, close: 2.0, volume: 10 },
    ])
    expect(candles).toEqual([{ t: 1790751960, o: 1.5, h: 2.5, l: 1.2, c: 2.0, v: 10 }])
  })

  it('keeps OHLC through the window clip', () => {
    const inWindow = { t: nowSec - 60, o: 1, h: 2, l: 0.5, c: 1.5, v: 7 }
    const out = clipCandlesToWindow(
      [inWindow, { t: Date.parse('2024-09-16T14:00:00Z') / 1000, o: 9, h: 9, l: 9, c: 9, v: 9 }],
      { now: NOW, windowSeconds: COPY_BAR_LIMIT * COPY_RESOLUTION_SECONDS },
    )
    expect(out).toEqual([inWindow])
  })

  it('writes the OHLC into the slot', () => {
    const plans = planSlotWrites(
      toCandleVolumes([
        { time: Date.parse('2026-10-01T12:05:00Z') / 1000, open: 1.5, high: 2.5, low: 1.2, close: 2.0, volume: 10 },
      ]),
    )
    expect(plans[0]!.slots[0]).toEqual({ slot: 6, value: 10, o: 1.5, h: 2.5, l: 1.2, c: 2.0 })
  })
})
