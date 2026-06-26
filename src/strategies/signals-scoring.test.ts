import { describe, expect, it } from 'vitest'
import {
  applyScoreToItem,
  buildSignalScoringItem,
  computeScoreAndDecision,
  computeTimeTo80Minutes,
  DEFAULT_HOLD_GROWTH_FLOOR,
  getHoldGrowthFloor,
  milestoneBonusEligible,
} from './signals-scoring'
import { DEFAULT_SIGNALS_SCORING } from './registry'
import type { SignalsStrategyConfig } from './types'

const baseConfig: SignalsStrategyConfig = {
  template: 'default',
  enterScoreFloor: 50,
  query: {
    limit: 50,
    recencyMinutes: 240,
    minGrowth: 0,
    holdGrowthFloor: DEFAULT_HOLD_GROWTH_FLOOR,
    includeStuck: false,
    maxAgeMinutes: 2880,
  },
  scoring: { ...DEFAULT_SIGNALS_SCORING },
  execution: { simBuySol: 0.01, maxOpenPositions: 10 },
}

function scoringItem(overrides: Partial<ReturnType<typeof buildSignalScoringItem>> = {}) {
  return buildSignalScoringItem({
    token_address: 'mint1',
    token_symbol: 'TEST',
    first_mcap: 100_000,
    current_mcap: 200_000,
    mcap_growth_percent: 100,
    first_seen_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    last_updated_at: new Date().toISOString(),
    when_reach_80mc: new Date(Date.now() - 20 * 60_000).toISOString(),
    when_reach_120mc: null,
    when_reach_200mc: null,
    is_tracking_stuck: false,
    in_tracking_range: true,
    ...overrides,
  })
}

describe('computeTimeTo80Minutes', () => {
  it('returns null when first_seen was clamped to milestone instant', () => {
    const ts = '2026-06-27T00:00:00.000Z'
    expect(computeTimeTo80Minutes(ts, ts)).toBeNull()
  })

  it('returns minutes between distinct timestamps', () => {
    expect(
      computeTimeTo80Minutes(
        '2026-06-27T00:00:00.000Z',
        '2026-06-27T00:30:00.000Z',
      ),
    ).toBe(30)
  })
})

describe('milestoneBonusEligible', () => {
  it('requires current growth at or above threshold', () => {
    expect(milestoneBonusEligible(79, 80)).toBe(false)
    expect(milestoneBonusEligible(80, 80)).toBe(true)
  })
})

describe('getHoldGrowthFloor', () => {
  it('uses holdGrowthFloor when minGrowth is 0', () => {
    expect(getHoldGrowthFloor(0, 10)).toBe(10)
    expect(getHoldGrowthFloor(0)).toBe(DEFAULT_HOLD_GROWTH_FLOOR)
  })

  it('uses half of minGrowth when minGrowth is positive', () => {
    expect(getHoldGrowthFloor(40)).toBe(20)
  })
})

describe('computeScoreAndDecision', () => {
  it('sell_over_100 exits at 100% growth', () => {
    const item = scoringItem({ mcap_growth_percent: 120 })
    const result = computeScoreAndDecision(item, { ...baseConfig, template: 'sell_over_100' })
    expect(result.decision).toBe('exit')
    expect(result.rationale).toContain('late-stage')
  })

  it('enter requires growth >= minGrowth and score >= enterFloor', () => {
    const item = scoringItem({
      mcap_growth_percent: -1.18,
      when_reach_80mc: new Date().toISOString(),
    })
    const result = computeScoreAndDecision(item, baseConfig)
    expect(result.decision).not.toBe('enter')
  })

  it('does not apply milestone bonuses when growth collapsed below threshold', () => {
    const ts = new Date(Date.now() - 30 * 60_000).toISOString()
    const withMilestones = scoringItem({
      mcap_growth_percent: 10,
      first_seen_at: ts,
      when_reach_80mc: ts,
      when_reach_120mc: ts,
    })
    const withoutMilestones = scoringItem({ mcap_growth_percent: 10, when_reach_80mc: null })

    const scoredWith = computeScoreAndDecision(withMilestones, baseConfig)
    const scoredWithout = computeScoreAndDecision(withoutMilestones, baseConfig)

    expect(scoredWith.score).toBe(scoredWithout.score)
    expect(scoredWith.rationale).not.toContain('Reached +80% threshold')
  })

  it('hold requires growth at or above holdGrowthFloor when minGrowth is 0', () => {
    const weak = computeScoreAndDecision(
      scoringItem({ mcap_growth_percent: 2, when_reach_80mc: null }),
      baseConfig,
    )
    const moderate = computeScoreAndDecision(
      scoringItem({ mcap_growth_percent: 15, when_reach_80mc: null }),
      baseConfig,
    )

    expect(weak.decision).toBe('skip')
    expect(moderate.decision).toBe('hold')
  })
})

describe('applyScoreToItem (rug-validation rescore path)', () => {
  it('recomputes decision when growth is refreshed downward', () => {
    const stale = applyScoreToItem(
      scoringItem({ mcap_growth_percent: 85 }),
      baseConfig,
    )
    expect(stale.decision).toBe('enter')

    const refreshed = applyScoreToItem(
      buildSignalScoringItem({
        ...scoringItem(),
        mcap_growth_percent: -1.18,
        current_mcap: 98_820,
        when_reach_80mc: stale.when_reach_80mc,
        in_tracking_range: true,
      }),
      baseConfig,
    )

    expect(refreshed.mcap_growth_percent).toBe(-1.18)
    expect(refreshed.decision).not.toBe('enter')
    expect(refreshed.rationale).not.toContain('Reached +80% threshold')
  })
})
