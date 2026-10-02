import { describe, expect, it } from 'vitest'
import {
  bucketize,
  cell,
  coreSweep,
  dedupeByMint,
  labelForward,
  liquidityView,
  staircaseView,
  wilson,
  type SeparationRow,
} from '@/strategies/rug-signal-separation'

/**
 * The separation maths is small but it is the part a reader has to trust, so the boundaries and the
 * "not a result yet" states are pinned rather than left to the page to imply.
 */

function row(input: Partial<SeparationRow> & { mint: string; createdAt: string }): SeparationRow {
  const staircase = input.staircase ?? 0
  const liquidity = input.liquidity ?? 0
  return {
    day: input.createdAt.slice(0, 10),
    score: input.score ?? 0,
    decision: input.decision ?? 'pass',
    staircase,
    liquidity,
    core: input.core ?? staircase + liquidity,
    liqRatio: input.liqRatio ?? null,
    collapsed: input.collapsed ?? false,
    ...input,
  } as SeparationRow
}

describe('rug-signal-separation — statistics', () => {
  it('returns a full interval for an empty denominator rather than a rate', () => {
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 })
    const empty = cell(0, 0)
    // The whole point: no rate at all. `0` would read as a measured zero.
    expect(empty.rate).toBeNull()
    expect(empty.ci).toBeNull()
    expect(empty.conclusive).toBe(false)
  })

  it('marks a cell conclusive only once it clears the sample floor', () => {
    expect(cell(1, 4).conclusive).toBe(false)
    expect(cell(1, 5).conclusive).toBe(true)
    // 0/12 IS a result (a measured zero on enough samples), unlike 0/0.
    expect(cell(0, 12).rate).toBe(0)
    expect(cell(0, 12).conclusive).toBe(true)
  })

  it('brackets the point estimate', () => {
    const ci = wilson(9, 22)
    expect(ci.lo).toBeGreaterThan(0)
    expect(ci.lo).toBeLessThan(9 / 22)
    expect(ci.hi).toBeGreaterThan(9 / 22)
    expect(ci.hi).toBeLessThan(1)
  })

  it('buckets on the lower bound (inclusive) and reports per-bucket counts', () => {
    const buckets = bucketize(
      [
        { x: 0, hit: false },
        { x: 24, hit: true },
        { x: 25, hit: true }, // the cliff: 25 belongs to the top bucket
        { x: 40, hit: true },
        { x: null, hit: true }, // unmeasurable — excluded, not counted as a negative
      ],
      [
        { label: '0–9', lo: 0, hi: 10 },
        { label: '10–24', lo: 10, hi: 25 },
        { label: '25–40', lo: 25, hi: 41 },
      ],
    )
    expect(buckets[0]).toMatchObject({ label: '0–9', n: 1, hits: 0 })
    expect(buckets[1]).toMatchObject({ label: '10–24', n: 1, hits: 1 })
    expect(buckets[2]).toMatchObject({ label: '25–40', n: 2, hits: 2 })
    expect(buckets.reduce((sum, b) => sum + b.n, 0)).toBe(4)
  })
})

describe('rug-signal-separation — samples', () => {
  it('keeps only the first evaluation per mint', () => {
    const deduped = dedupeByMint([
      row({ mint: 'A', createdAt: '2026-10-01T00:00:00Z', collapsed: true }),
      row({ mint: 'A', createdAt: '2026-10-01T01:00:00Z', collapsed: false }),
      row({ mint: 'B', createdAt: '2026-10-01T02:00:00Z', collapsed: false }),
    ])
    expect(deduped).toHaveLength(2)
    expect(deduped[0]).toMatchObject({ mint: 'A', collapsed: true, createdAt: '2026-10-01T00:00:00Z' })
    expect(deduped[1].mint).toBe('B')
  })

  it('labels forward, and returns null — not false — when the forward minutes are missing', () => {
    const at = '2026-10-01T00:00:00Z'
    const base = Math.floor(Date.parse(at) / 1000)
    const series = [
      { t: base - 60, c: 100 },
      { t: base + 60, c: 100 },
      { t: base + 600, c: 30 }, // −70% inside the 30-minute window
    ]
    expect(labelForward(at, series)).toBe(true)
    // No minutes after the row: unknown, so it stays null and the row is excluded rather than
    // silently counted among the negatives.
    expect(labelForward(at, [{ t: base - 60, c: 100 }])).toBeNull()
    // A shallow dip is a measured negative.
    expect(
      labelForward(at, [
        { t: base - 60, c: 100 },
        { t: base + 60, c: 100 },
        { t: base + 300, c: 95 },
      ]),
    ).toBe(false)
  })

  it('ignores minutes beyond the window when judging the trough', () => {
    const at = '2026-10-01T00:00:00Z'
    const base = Math.floor(Date.parse(at) / 1000)
    expect(
      labelForward(at, [
        { t: base - 60, c: 100 },
        { t: base + 60, c: 100 },
        { t: base + 3600, c: 10 }, // an hour later — outside the 30-minute window
      ]),
    ).toBe(false)
  })

  it('sweeps the staircase with the trip count visible at every candidate', () => {
    const rows = [
      row({ mint: 'A', createdAt: '2026-10-01T00:00:00Z', staircase: 30, collapsed: true }),
      row({ mint: 'B', createdAt: '2026-10-01T00:00:00Z', staircase: 25, collapsed: false }),
      row({ mint: 'C', createdAt: '2026-10-01T00:00:00Z', staircase: 12, collapsed: true }),
    ]
    const { buckets, sweep } = staircaseView(rows)
    expect(buckets[2]).toMatchObject({ n: 2, hits: 1 })
    const at30 = sweep.find((s) => s.candidate === 30)!
    expect(at30).toMatchObject({ n: 1, hits: 1 })
    const at10 = sweep.find((s) => s.candidate === 10)!
    expect(at10).toMatchObject({ n: 3, hits: 2 })
  })

  it('applies the liquidity floor in the core sweep (the shipped rule shape)', () => {
    const rows = [
      // A perfect staircase over thin liquidity: the floor must exclude it, which is precisely the
      // behaviour under review.
      row({ mint: 'A', createdAt: '2026-10-01T00:00:00Z', staircase: 40, liquidity: 0, collapsed: true }),
      row({ mint: 'B', createdAt: '2026-10-01T00:00:00Z', staircase: 35, liquidity: 10, collapsed: true }),
    ]
    const sweep = coreSweep(rows)
    // A (staircase 40, liquidity 0) is invisible at every candidate: the floor excludes it even
    // though its core meets the threshold — the behaviour this test exists to keep visible.
    expect(sweep.find((s) => s.candidate === 46)!.n).toBe(0)
    expect(sweep.find((s) => s.candidate === 46)!.rate).toBeNull()
    // B's core is 45, so it qualifies at 40 and below — and it did collapse.
    expect(sweep.find((s) => s.candidate === 40)!).toMatchObject({ n: 1, hits: 1 })
    expect(sweep.find((s) => s.candidate === 35)!).toMatchObject({ n: 1, hits: 1 })
  })

  it('buckets liquidity on the raw ratio and skips rows that have none', () => {
    const rows = [
      row({ mint: 'A', createdAt: '2026-10-01T00:00:00Z', liqRatio: 0.01, collapsed: true }),
      row({ mint: 'B', createdAt: '2026-10-01T00:00:00Z', liqRatio: 0.5, collapsed: false }),
      row({ mint: 'C', createdAt: '2026-10-01T00:00:00Z', liqRatio: null, collapsed: true }),
    ]
    const { buckets } = liquidityView(rows)
    expect(buckets[0]).toMatchObject({ label: '< 2%', n: 1, hits: 1 })
    expect(buckets[3]).toMatchObject({ label: '≥ 10%', n: 1, hits: 0 })
    expect(buckets.reduce((sum, b) => sum + b.n, 0)).toBe(2)
  })
})
