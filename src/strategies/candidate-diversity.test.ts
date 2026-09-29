import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SEARCH_DIVERSITY_MAX_JACCARD,
  annotateCandidateDiversity,
  getSearchDiversityMaxJaccard,
  searchDiversityEnforced,
  sharedTokenCount,
  tokenSetJaccard,
} from './candidate-diversity'

const set = (...xs: string[]) => new Set(xs)

describe('tokenSetJaccard', () => {
  it('is 1 for identical sets and 0 for disjoint ones', () => {
    expect(tokenSetJaccard(set('a', 'b'), set('a', 'b'))).toBe(1)
    expect(tokenSetJaccard(set('a'), set('b'))).toBe(0)
  })

  it('matches the measured grid-neighbour overlap shape', () => {
    // Prod: tp200/tp300 shared 109 tokens out of 147/127 -> Jaccard 0.66.
    const shared = Array.from({ length: 109 }, (_, i) => `shared${i}`)
    const tp200 = new Set([...shared, ...Array.from({ length: 38 }, (_, i) => `only200_${i}`)])
    const tp300 = new Set([...shared, ...Array.from({ length: 18 }, (_, i) => `only300_${i}`)])
    expect(tp200.size).toBe(147)
    expect(tp300.size).toBe(127)
    expect(tokenSetJaccard(tp200, tp300)).toBeCloseTo(109 / (147 + 127 - 109), 3)
    expect(sharedTokenCount(tp200, tp300)).toBe(109)
  })

  it('treats an empty set as no evidence', () => {
    expect(tokenSetJaccard(set(), set('a'))).toBe(0)
    expect(sharedTokenCount(set(), set('a'))).toBe(0)
  })

  it('is symmetric', () => {
    const a = set('a', 'b', 'c')
    const b = set('b', 'c', 'd')
    expect(tokenSetJaccard(a, b)).toBe(tokenSetJaccard(b, a))
    expect(sharedTokenCount(a, b)).toBe(2)
  })
})

describe('annotateCandidateDiversity', () => {
  it('flags a clone as redundant and names the counterpart', () => {
    const active = [{ id: 'search_a', tokens: set('t1', 't2', 't3', 't4') }]
    const candidates = [{ id: 'search_b', tokens: set('t1', 't2', 't3', 't5') }]
    const [row] = annotateCandidateDiversity({ candidates, active, maxJaccard: 0.5 })
    expect(row!.counterpart_id).toBe('search_a')
    expect(row!.redundant).toBe(true)
    // 3 shared of 5 union
    expect(row!.max_jaccard).toBeCloseTo(0.6, 3)
    expect(row!.shared).toBe(3)
  })

  it('leaves a genuinely different candidate alone', () => {
    const active = [{ id: 'search_a', tokens: set('t1', 't2', 't3', 't4') }]
    const candidates = [{ id: 'search_b', tokens: set('z1', 'z2', 'z3', 'z4') }]
    const [row] = annotateCandidateDiversity({ candidates, active, maxJaccard: 0.5 })
    expect(row!.redundant).toBe(false)
    expect(row!.max_jaccard).toBe(0)
  })

  it('picks the highest-overlap active variant when several exist', () => {
    const active = [
      { id: 'far', tokens: set('x1', 'x2', 'x3', 'x4') },
      { id: 'near', tokens: set('t1', 't2', 't3', 't9') },
    ]
    const candidates = [{ id: 'search_b', tokens: set('t1', 't2', 't3', 't8') }]
    const [row] = annotateCandidateDiversity({ candidates, active, maxJaccard: 0.5 })
    expect(row!.counterpart_id).toBe('near')
  })

  it('is not redundant with no active variants', () => {
    const [row] = annotateCandidateDiversity({
      candidates: [{ id: 'search_b', tokens: set('t1') }],
      active: [],
      maxJaccard: 0.5,
    })
    expect(row!.redundant).toBe(false)
    expect(row!.counterpart_id).toBeNull()
  })
})

describe('env gating', () => {
  it('is off unless explicitly enabled', () => {
    expect(searchDiversityEnforced({})).toBe(false)
    expect(searchDiversityEnforced({ SEARCH_DIVERSITY_ENFORCE: '1' })).toBe(true)
    expect(searchDiversityEnforced({ SEARCH_DIVERSITY_ENFORCE: 'false' })).toBe(false)
  })

  it('defaults the threshold and rejects nonsense values', () => {
    expect(getSearchDiversityMaxJaccard({})).toBe(DEFAULT_SEARCH_DIVERSITY_MAX_JACCARD)
    expect(getSearchDiversityMaxJaccard({ SEARCH_DIVERSITY_MAX_JACCARD: '0.8' })).toBe(0.8)
    expect(getSearchDiversityMaxJaccard({ SEARCH_DIVERSITY_MAX_JACCARD: '2' })).toBe(
      DEFAULT_SEARCH_DIVERSITY_MAX_JACCARD,
    )
  })
})
