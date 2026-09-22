import { describe, expect, it } from 'vitest'
import {
  RESEARCHY_MIN_N_7D,
  RESEARCHY_MIN_N_ALL_TIME,
  bestStrategyCompositeScore,
  qualifyBestStrategies,
  qualifiesResearchyMinN,
  rankBestStrategies,
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

describe('qualifyBestStrategies', () => {
  it('excludes tiny-n strategies even with high avg', () => {
    const ranked = qualifyBestStrategies({
      allTime: [
        bucket({
          strategy_id: 'tiny_moon',
          domain: 'signals',
          trade_count: 4,
          win_rate: 1,
          avg_pnl_pct: 200,
          total_pnl_pct: 800,
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
    expect(ranked.map((r) => r.strategy_id)).toEqual([
      'mcap_enter_at_80',
      'mcap_enter_first_seen',
    ])
    expect(ranked.some((r) => r.strategy_id === 'tiny_moon')).toBe(false)
  })

  it('admits via 7d floor when all-time is thin', () => {
    const ranked = qualifyBestStrategies({
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
    expect(ranked).toHaveLength(1)
    expect(ranked[0]?.strategy_id).toBe('fresh')
  })

  it('ranks by composite then sum% secondary', () => {
    const ranked = qualifyBestStrategies({
      allTime: [
        bucket({
          strategy_id: 'a',
          domain: 'mcap_tracker',
          trade_count: 30,
          win_rate: 0.5,
          avg_pnl_pct: 10,
          total_pnl_pct: 50,
        }),
        bucket({
          strategy_id: 'b',
          domain: 'mcap_tracker',
          trade_count: 30,
          win_rate: 0.5,
          avg_pnl_pct: 10,
          total_pnl_pct: 200,
        }),
      ],
      week: [],
      topN: 5,
    })
    // same score 10*30+50=350; sum% breaks tie
    expect(ranked.map((r) => r.strategy_id)).toEqual(['b', 'a'])
  })
})

describe('rankBestStrategies', () => {
  it('sorts by locked composite', () => {
    const ranked = rankBestStrategies(
      [
        bucket({
          strategy_id: 'solid',
          domain: 'mcap_tracker',
          trade_count: 20,
          win_rate: 0.55,
          avg_pnl_pct: 15,
        }),
        bucket({
          strategy_id: 'low',
          domain: 'signals',
          trade_count: 5,
          win_rate: 1,
          avg_pnl_pct: 10,
        }),
      ],
      { topN: 10 },
    )
    expect(ranked[0]?.strategy_id).toBe('solid')
    expect(ranked[0]?.score).toBe(15 * 20 + 55)
  })
})
