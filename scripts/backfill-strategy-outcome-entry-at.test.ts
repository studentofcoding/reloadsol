import { describe, expect, it } from 'vitest'
import {
  cyclesForRecords,
  lastBuyAtOrBefore,
  nearestCloseIndex,
  planUpdates,
} from './backfill-strategy-outcome-entry-at-standalone.mjs'

const MINT = 'mintA'
const isoMs = (ms: number) => new Date(ms).toISOString()
/** Distinct, real ISO entry stamp (the column is timestamptz). */
const stamp = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString()

const rec = (
  ts: number,
  op: 'buy' | 'sell',
  entryAt: string | null = null,
  isClose = false,
) => ({ mint: MINT, ts, op, isClose, entryAt })

const out = (id: string, exitMs: number, entry_at: string | null = 'stale') => ({
  id,
  token_address: MINT,
  entry_at,
  exit_at: isoMs(exitMs),
})

const run = (records: ReturnType<typeof rec>[], outcomes: ReturnType<typeof out>[]) =>
  planUpdates(outcomes, cyclesForRecords(records))

describe('nearestCloseIndex', () => {
  it('finds the nearest close in either direction', () => {
    const closes = [{ ts: 1_000 }, { ts: 5_000 }, { ts: 9_000 }]
    expect(nearestCloseIndex(closes, 5_100).index).toBe(1)
    expect(nearestCloseIndex(closes, 4_900).index).toBe(1)
    expect(nearestCloseIndex(closes, 100).index).toBe(0)
  })

  it('rejects a close outside the tolerance', () => {
    const closes = [{ ts: 1_000 }]
    expect(nearestCloseIndex(closes, 1_000_000, 60_000).index).toBe(-1)
  })
})

describe('lastBuyAtOrBefore', () => {
  const buys = [
    { ts: 1_000, entryAt: 'a' },
    { ts: 5_000, entryAt: 'b' },
    { ts: 9_000, entryAt: 'c' },
  ]

  it('returns the latest buy at or before the timestamp', () => {
    expect(lastBuyAtOrBefore(buys, 9_000)).toBe('c')
    expect(lastBuyAtOrBefore(buys, 8_999)).toBe('b')
    expect(lastBuyAtOrBefore(buys, 1_000)).toBe('a')
  })

  it('returns null when every buy is after the timestamp', () => {
    expect(lastBuyAtOrBefore(buys, 999)).toBeNull()
    expect(lastBuyAtOrBefore([], 1_000)).toBeNull()
  })
})

describe('entry_at re-derivation', () => {
  const A = stamp(1)
  const B = stamp(2)
  const C = stamp(3)

  it('gives each re-entry its own cycle opening (the att_rh regression)', () => {
    const records = [
      rec(1_000, 'buy', A),
      rec(2_000, 'sell', null, true),
      rec(3_000, 'buy', B),
      rec(4_000, 'sell', null, true),
      rec(5_000, 'buy', C),
    ]
    // both rows were stamped with the first-ever buy
    const { updates, stats } = run(records, [out('o1', 2_000, A), out('o2', 4_000, A)])
    expect(stats.unmatched).toBe(0)
    expect(updates).toEqual([{ id: 'o2', entry_at: B }])
    expect(stats.unchanged).toBe(1)
  })

  it('two re-entries of one mint end up with distinct entry keys', () => {
    const records = [
      rec(1_000, 'buy', A),
      rec(2_000, 'sell', null, true),
      rec(3_000, 'buy', B),
      rec(4_000, 'sell', null, true),
    ]
    const { updates } = run(records, [out('o1', 2_000, A), out('o2', 4_000, A)])
    expect(new Set(updates.map((u) => u.entry_at)).size).toBe(updates.length)
  })

  it('uses the opening buy of the cycle, not a later add', () => {
    const records = [
      rec(1_000, 'buy', A),
      rec(1_500, 'buy', B),
      rec(2_000, 'sell', null, true),
    ]
    const { updates } = run(records, [out('o1', 2_000)])
    expect(updates).toEqual([{ id: 'o1', entry_at: A }])
  })

  it('orders a close before a buy sharing its instant', () => {
    const records = [
      rec(1_000, 'buy', A),
      rec(2_000, 'sell', null, true),
      rec(2_000, 'buy', B),
      rec(3_000, 'sell', null, true),
    ]
    const { updates } = run(records, [out('o0', 2_000, A), out('o1', 3_000, A)])
    expect(updates).toEqual([{ id: 'o1', entry_at: B }])
  })

  it('leaves an outcome untouched when there is neither a close nor a buy before it', () => {
    // exit before the only buy: no close in range and no cycle open yet.
    const { updates, stats, unsolvable } = run([rec(1_000, 'buy', A)], [out('o1', 500)])
    expect(updates).toEqual([])
    expect(stats.unmatched).toBe(1)
    expect(stats.fallbackBuy).toBe(0)
    expect(unsolvable).toEqual([
      { id: 'o1', mint: MINT, exit_at: isoMs(500), reason: 'no_close_no_buy' },
    ])
  })

  it('derives the entry from the buy when the close record is missing', () => {
    // Real shape: the mint has a buy but the close sell never landed, yet an
    // outcome was written 5 minutes later.
    const records = [rec(1_000, 'buy', A)]
    const { updates, stats } = run(records, [out('o1', 1_000 + 5 * 60_000)])
    expect(stats.fallbackBuy).toBe(1)
    expect(stats.unmatched).toBe(0)
    expect(updates).toEqual([{ id: 'o1', entry_at: A }])
  })

  it('does not fall back when a close matched but had no opening buy', () => {
    // Falling back here would return the previous cycle's buy and collide with it.
    const records = [
      rec(1_000, 'buy', A),
      rec(2_000, 'sell', null, true),
      rec(3_000, 'sell', null, true),
    ]
    const { updates, stats, unsolvable } = run(records, [out('o0', 2_000, A), out('o1', 3_000, A)])
    expect(updates).toEqual([])
    expect(stats.noOpeningBuy).toBe(1)
    expect(stats.fallbackBuy).toBe(0)
    expect(unsolvable.map((u) => u.reason)).toEqual(['close_without_opening_buy'])
  })

  it('reports a close with no preceding buy instead of inventing an entry', () => {
    const { updates, stats } = run([rec(2_000, 'sell', null, true)], [out('o1', 2_000)])
    expect(updates).toEqual([])
    expect(stats.noOpeningBuy).toBe(1)
  })

  it('is a no-op when the stored entry already matches', () => {
    const records = [rec(1_000, 'buy', A), rec(2_000, 'sell', null, true)]
    const { updates, stats } = run(records, [out('o1', 2_000, A)])
    expect(updates).toEqual([])
    expect(stats.changed).toBe(0)
    expect(stats.unchanged).toBe(1)
    expect(stats.unmatched).toBe(0)
    expect(stats.noOpeningBuy).toBe(0)
    expect(stats.maxDiff).toBe(0)
  })
})
