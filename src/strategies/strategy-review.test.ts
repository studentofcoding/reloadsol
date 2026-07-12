import { describe, expect, it } from 'vitest'
import type { StrategyOutcomeRow } from './types'
import {
  buildStrategyReview,
  heuristicReviewPatterns,
  isoWeekKey,
  mistakePhaseFromOutcome,
  tagsForOutcome,
} from './strategy-review'

function outcome(
  partial: Partial<StrategyOutcomeRow> & Pick<StrategyOutcomeRow, 'strategy_id' | 'domain'>,
): StrategyOutcomeRow {
  return {
    id: partial.id ?? '1',
    strategy_id: partial.strategy_id,
    domain: partial.domain,
    token_address: partial.token_address ?? 'mint',
    entry_at: partial.entry_at ?? '2026-06-01T00:00:00.000Z',
    exit_at: partial.exit_at ?? '2026-06-02T00:00:00.000Z',
    pnl_pct: partial.pnl_pct ?? null,
    status: partial.status ?? 'lost',
    is_simulated: partial.is_simulated ?? true,
    features: partial.features ?? null,
    created_at: partial.created_at ?? '2026-06-02T00:00:00.000Z',
  }
}

describe('strategy-review', () => {
  it('isoWeekKey is stable', () => {
    expect(isoWeekKey('2026-07-06T12:00:00.000Z')).toMatch(/^2026-W\d{2}$/)
  })

  it('maps security exit to entry phase', () => {
    expect(
      mistakePhaseFromOutcome(
        outcome({
          strategy_id: 'gmgn_sm',
          domain: 'gmgn',
          status: 'lost',
          features: { exit_reason: 'honeypot detected' },
        }),
      ),
    ).toBe('entry')
  })

  it('builds streaks for loss tags across weeks', () => {
    const now = new Date('2026-07-13T00:00:00.000Z')
    const rows = [
      outcome({
        strategy_id: 'a',
        domain: 'gmgn',
        exit_at: '2026-06-30T12:00:00.000Z',
        pnl_pct: -10,
        status: 'lost',
      }),
      outcome({
        strategy_id: 'a',
        domain: 'gmgn',
        exit_at: '2026-07-07T12:00:00.000Z',
        pnl_pct: -12,
        status: 'lost',
      }),
      outcome({
        strategy_id: 'a',
        domain: 'gmgn',
        exit_at: '2026-07-07T14:00:00.000Z',
        pnl_pct: 5,
        status: 'won',
      }),
    ]
    const review = buildStrategyReview(rows, { weeks: 4, now })
    expect(tagsForOutcome(rows[0])).toContain('loss:gmgn/a')
    const streak = review.streaks.find((s) => s.tag === 'loss:gmgn/a')
    expect(streak?.length).toBeGreaterThanOrEqual(2)
    expect(review.punchCard.tags.length).toBeGreaterThan(0)
  })

  it('heuristic flags plan vs behavior', () => {
    const now = new Date('2026-07-13T00:00:00.000Z')
    const rows = [
      outcome({
        strategy_id: 'hot',
        domain: 'gmgn',
        exit_at: '2026-06-30T12:00:00.000Z',
        pnl_pct: -10,
      }),
      outcome({
        strategy_id: 'hot',
        domain: 'gmgn',
        exit_at: '2026-07-07T12:00:00.000Z',
        pnl_pct: -8,
      }),
    ]
    const review = buildStrategyReview(rows, { weeks: 4, now })
    const earlyWeek = review.weeks.find((w) => (w.tags['loss:gmgn/hot'] ?? 0) > 0)?.weekKey
    expect(earlyWeek).toBeTruthy()
    const patterns = heuristicReviewPatterns(review, {
      [earlyWeek!]: 'cut size on hot this week',
    })
    expect(patterns.some((p) => /Plan vs behavior/i.test(p))).toBe(true)
  })
})
