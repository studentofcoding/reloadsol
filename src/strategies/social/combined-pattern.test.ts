import { describe, expect, it } from 'vitest'
import {
  WINNER_MIN_GROWTH_PCT,
  LOSER_MAX_GROWTH_PCT,
  buildCombinedPattern,
  classifyMcapPatternCohort,
} from './combined-pattern'

describe('classifyMcapPatternCohort', () => {
  it('classifies >= 120 as winner', () => {
    expect(classifyMcapPatternCohort(446)).toBe('winner')
    expect(classifyMcapPatternCohort(WINNER_MIN_GROWTH_PCT)).toBe('winner')
  })

  it('classifies < 80 as loser', () => {
    expect(classifyMcapPatternCohort(50)).toBe('loser')
    expect(classifyMcapPatternCohort(LOSER_MAX_GROWTH_PCT - 0.01)).toBe('loser')
  })

  it('classifies 80–119 as neutral', () => {
    expect(classifyMcapPatternCohort(100)).toBe('neutral')
    expect(classifyMcapPatternCohort(80)).toBe('neutral')
    expect(classifyMcapPatternCohort(119.9)).toBe('neutral')
  })
})

describe('buildCombinedPattern', () => {
  it('places mcapTracker before socialEvents in export shape', () => {
    const mcapRow = { token_address: 'mint1', first_mcap: 50000 }
    const events = [{ id: 'e1', event_type: 'mention' }]
    const combined = buildCombinedPattern({
      tokenAddress: 'mint1',
      exportedAt: '2026-07-04T18:00:00.000Z',
      mcapRow,
      socialEvents: events,
    })
    expect(combined.tokenAddress).toBe('mint1')
    expect(combined.mcapTracker).toEqual(mcapRow)
    expect(combined.socialEvents).toEqual(events)
    expect(Object.keys(combined)).toEqual([
      'tokenAddress',
      'exportedAt',
      'mcapTracker',
      'socialEvents',
    ])
  })

  it('sets socialEvents null for empty array', () => {
    const combined = buildCombinedPattern({
      tokenAddress: 'mint1',
      exportedAt: '2026-07-04T18:00:00.000Z',
      mcapRow: { first_mcap: 1 },
      socialEvents: [],
    })
    expect(combined.socialEvents).toBeNull()
  })
})
