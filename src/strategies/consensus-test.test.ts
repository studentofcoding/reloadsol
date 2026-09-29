import { describe, expect, it } from 'vitest'
import {
  bootstrapMedianCI,
  bootstrapMedianDiffCI,
  median,
  runConsensusTest,
  wilsonCI,
  type ConsensusTokenInput,
} from './consensus-test'

const token = (families: number, pnl: number): ConsensusTokenInput => ({
  families: Array.from({ length: families }, (_, i) => `f${i}`),
  pnls: [pnl],
})

describe('median', () => {
  it('handles odd, even and empty inputs', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBeNull()
  })
})

describe('wilsonCI', () => {
  it('matches the hand-computed interval at p=0.5, n=10', () => {
    const ci = wilsonCI(5, 10)!
    expect(ci[0]).toBeCloseTo(0.2366, 3)
    expect(ci[1]).toBeCloseTo(0.7634, 3)
  })

  it('stays inside [0,1] and returns null for n<=0', () => {
    const ci = wilsonCI(0, 5)!
    expect(ci[0]).toBeGreaterThanOrEqual(0)
    expect(ci[1]).toBeLessThanOrEqual(1)
    expect(wilsonCI(0, 0)).toBeNull()
  })
})

describe('bootstrap CIs', () => {
  it('is deterministic for a given seed', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8]
    const a = bootstrapMedianCI(values, { samples: 500, rng: seeded(1) })
    const b = bootstrapMedianCI(values, { samples: 500, rng: seeded(1) })
    expect(a).toEqual(b)
  })

  it('narrows as n grows', () => {
    const small = [-2, -1, 0, 1, 2]
    const large = Array.from({ length: 500 }, (_, i) => ((i % 5) - 2))
    const w = (ci: [number, number]) => ci[1] - ci[0]
    const ciSmall = bootstrapMedianCI(small, { samples: 2000, rng: seeded(7) })!
    const ciLarge = bootstrapMedianCI(large, { samples: 2000, rng: seeded(7) })!
    expect(w(ciLarge)).toBeLessThan(w(ciSmall))
  })

  it('returns null for empty input', () => {
    expect(bootstrapMedianCI([])).toBeNull()
    expect(bootstrapMedianDiffCI([], [1])).toBeNull()
  })
})

/** Local seeded rng so these assertions do not depend on the module's default seed. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('runConsensusTest', () => {
  it('detects a planted lift when both buckets clear the token floor', () => {
    const tokens: ConsensusTokenInput[] = [
      ...Array.from({ length: 60 }, () => token(1, 10)),
      ...Array.from({ length: 60 }, () => token(2, 200)),
    ]
    const result = runConsensusTest(tokens, { samples: 2000 })
    const lift = result.lifts.find((l) => l.vs === '1')!
    expect(lift.significant).toBe(true)
    expect(lift.inconclusive).toBe(false)
    expect(lift.delta_ci![0]).toBeGreaterThan(0)
  })

  it('does not claim a lift when the groups are the same', () => {
    const tokens: ConsensusTokenInput[] = [
      ...Array.from({ length: 60 }, (_, i) => token(1, i % 7)),
      ...Array.from({ length: 60 }, (_, i) => token(2, i % 7)),
    ]
    const lift = runConsensusTest(tokens, { samples: 2000 }).lifts.find((l) => l.vs === '1')!
    expect(lift.significant).toBe(false)
    expect(lift.inconclusive).toBe(true)
    expect(lift.reason).toContain('CI straddles 0')
  })

  it('reports inconclusive below the token floor instead of a lift', () => {
    const tokens: ConsensusTokenInput[] = [
      ...Array.from({ length: 60 }, () => token(1, 0)),
      ...Array.from({ length: 3 }, () => token(2, 500)),
    ]
    const lift = runConsensusTest(tokens, { samples: 2000 }).lifts.find((l) => l.vs === '1')!
    expect(lift.significant).toBe(false)
    expect(lift.inconclusive).toBe(true)
    expect(lift.reason).toContain('thin sample')
  })

  it('caps breadth at 3+ and counts families, not strategies', () => {
    const tokens: ConsensusTokenInput[] = [
      { families: ['a'], pnls: [1] },
      { families: ['a', 'b'], pnls: [1] },
      { families: ['a', 'b', 'c'], pnls: [1] },
      { families: ['a', 'b', 'c', 'd'], pnls: [1] },
    ]
    const buckets = runConsensusTest(tokens).buckets
    expect(buckets.map((b) => b.family_count)).toEqual([1, 2, 3])
    expect(buckets.find((b) => b.family_count === 3)!.tokens).toBe(2)
  })

  it('uses per-token medians as the unit and reports the token win rate', () => {
    const tokens: ConsensusTokenInput[] = [
      { families: ['a'], pnls: [10, -10, -10] }, // token median -10 → a loss
      { families: ['a'], pnls: [10, 10, -1] }, // token median 10 → a win
    ]
    const bucket = runConsensusTest(tokens).buckets[0]!
    expect(bucket.tokens).toBe(2)
    expect(bucket.trades).toBe(6)
    expect(bucket.median_pnl_pct).toBe(0)
    expect(bucket.win_rate).toBe(0.5)
  })

  it('is reproducible: same input and seed give the same CIs', () => {
    const tokens = [
      ...Array.from({ length: 40 }, () => token(1, 5)),
      ...Array.from({ length: 40 }, () => token(2, 50)),
    ]
    const a = runConsensusTest(tokens, { samples: 1000, seed: 42 })
    const b = runConsensusTest(tokens, { samples: 1000, seed: 42 })
    expect(a).toEqual(b)
  })

  it('skips tokens with no finite pnl', () => {
    const tokens: ConsensusTokenInput[] = [
      { families: ['a'], pnls: [] },
      { families: ['a'], pnls: [Number.NaN] },
    ]
    expect(runConsensusTest(tokens).buckets).toEqual([])
  })
})
