import { describe, expect, it } from 'vitest'
import {
  ORPHAN_RECONCILE_CLOSE_REASON,
  isTradeOutcome,
  outcomeCountsAsTradeSql,
} from './outcome-exclusions'

describe('outcome exclusions', () => {
  it('names the orphan-reconcile close reason', () => {
    expect(ORPHAN_RECONCILE_CLOSE_REASON).toBe('orphan_reconcile')
  })

  it('builds a NULL-safe SQL predicate for any features column', () => {
    expect(outcomeCountsAsTradeSql()).toBe(
      `COALESCE(features->>'close_reason', '') NOT IN ('orphan_reconcile')`,
    )
    expect(outcomeCountsAsTradeSql('o.features')).toContain(`o.features->>'close_reason'`)
  })

  it('classifies rows in memory', () => {
    expect(isTradeOutcome({ close_reason: 'stop_loss' })).toBe(true)
    expect(isTradeOutcome({})).toBe(true)
    expect(isTradeOutcome(null)).toBe(true)
    expect(isTradeOutcome({ close_reason: 'orphan_reconcile' })).toBe(false)
  })
})
