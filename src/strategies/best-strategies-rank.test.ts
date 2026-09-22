import { describe, expect, it } from 'vitest'
import {
  RESEARCHY_MIN_N_7D,
  RESEARCHY_MIN_N_ALL_TIME,
  bestStrategyCompositeScore,
  qualifyBestStrategies,
  qualifiesResearchyMinN,
  rankedBestStrategyIds,
} from './best-strategies-rank'
import type { StrategyReportBreakdown } from './types'

function bucket(
  overrides: Partial<StrategyReportBreakdown> &
    Pick<StrategyReportBreakdown, 'strategy_id' | 'domain'>,
): StrategyReportBreakdown {
  return {
    is_simulated: true,
    trade_count: 10,
    win_count: 6,
    loss_count: 4,
    win_rate: 0.6,
    avg_pnl_pct: 20,
    median_pnl_pct: 10,
    total_pnl_pct: 200,
    last_exit_at: null,
    ...overrides,
  }
}

describe('bestStrategyCompositeScore', () => {
  it('locks avg×n+win%', () => {
    expect(bestStrategyCompositeScore(25, 10, 60)).toBe(310)
  })
})

describe('qualifiesResearchyMinN', () => {
  it('requires all-time ≥30 or 7d ≥10', () => {
    expect(qualifiesResearchyMinN(RESEARCHY_MIN_N_ALL_TIME, 0)).toBe(true)
    expect(qualifiesResearchyMinN(0, RESEARCHY_MIN_N_7D)).toBe(true)
    expect(qualifiesResearchyMinN(29, 9)).toBe(false)
  })
})

describe('qualifyBestStrategies (Researchy lock)', () => {
  it('keeps Sell-over-100 style tiny-n out of ranked top slots', () => {
    const board = qualifyBestStrategies({
      allTime: [
        bucket({
          strategy_id: 'signals_sell_over_100',
          domain: 'signals',
          trade_count: 6,
          win_rate: 1,
          avg_pnl_pct: 500,
          total_pnl_pct: 3000,
        }),
        bucket({
          strategy_id: 'mcap_enter_at_80',
          domain: 'mcap_tracker',
          trade_count: 40,
          win_rate: 0.55,
          avg_pnl_pct: 18,
          total_pnl_pct: 720,
        }),
        bucket({
          strategy_id: 'mcap_enter_first_seen',
          domain: 'mcap_tracker',
          trade_count: 35,
          win_rate: 0.5,
          avg_pnl_pct: 16,
          total_pnl_pct: 560,
        }),
      ],
      week: [],
      topN: 5,
    })

    expect(board.ranked.map((r) => r.strategy_id)).toEqual([
      'mcap_enter_at_80',
      'mcap_enter_first_seen',
    ])
    expect(
      board.hypothesis.some((r) => r.strategy_id === 'signals_sell_over_100'),
    ).toBe(true)
    expect(
      board.hypothesis.find((r) => r.strategy_id === 'signals_sell_over_100')
        ?.hypothesis,
    ).toBe(true)
    expect(rankedBestStrategyIds(board)).not.toContain('signals_sell_over_100')
  })

  it('does not use sum% to order ranked slots (footnote only)', () => {
    const board = qualifyBestStrategies({
      allTime: [
        bucket({
          strategy_id: 'aaa_low_sum',
          domain: 'mcap_tracker',
          trade_count: 30,
          win_rate: 0.5,
          avg_pnl_pct: 10,
          total_pnl_pct: 50,
        }),
        bucket({
          strategy_id: 'zzz_high_sum',
          domain: 'mcap_tracker',
          trade_count: 30,
          win_rate: 0.5,
          avg_pnl_pct: 10,
          total_pnl_pct: 9999,
        }),
      ],
      week: [],
      topN: 5,
    })
    // Same composite → stable strategy_id order; high sum% must not jump ahead.
    expect(board.ranked.map((r) => r.strategy_id)).toEqual([
      'aaa_low_sum',
      'zzz_high_sum',
    ])
    expect(board.ranked[1]?.sum_pnl_pct).toBe(9999)
  })

  it('admits via 7d floor when all-time is thin', () => {
    const board = qualifyBestStrategies({
      allTime: [
        bucket({
          strategy_id: 'fresh',
          domain: 'gmgn',
          trade_count: 8,
          win_rate: 0.75,
          avg_pnl_pct: 30,
          total_pnl_pct: 240,
        }),
      ],
      week: [
        bucket({
          strategy_id: 'fresh',
          domain: 'gmgn',
          trade_count: 12,
          win_rate: 0.75,
          avg_pnl_pct: 30,
          total_pnl_pct: 360,
        }),
      ],
      topN: 3,
    })
    expect(board.ranked).toHaveLength(1)
    expect(board.ranked[0]?.strategy_id).toBe('fresh')
    expect(board.ranked[0]?.hypothesis).toBe(false)
    expect(board.hypothesis).toHaveLength(0)
  })

  it('orders ranked by avg×n+win% only', () => {
    const board = qualifyBestStrategies({
      allTime: [
        bucket({
          strategy_id: 'solid',
          domain: 'mcap_tracker',
          trade_count: 40,
          win_rate: 0.55,
          avg_pnl_pct: 15,
          total_pnl_pct: 100,
        }),
        bucket({
          strategy_id: 'weaker',
          domain: 'mcap_tracker',
          trade_count: 30,
          win_rate: 0.5,
          avg_pnl_pct: 10,
          total_pnl_pct: 9000,
        }),
      ],
      week: [],
      topN: 5,
    })
    expect(board.ranked[0]?.strategy_id).toBe('solid')
    expect(board.ranked[0]?.score).toBe(15 * 40 + 55)
  })
})
