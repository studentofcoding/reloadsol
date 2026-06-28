import { describe, expect, it } from 'vitest'
import {
  computeMlDatasetStats,
  extractMlFeatureVector,
  extractMlTrainingRow,
  hasTrainingClass,
  resolveEffectiveTrainingClass,
} from './ml-training-features'
import type { StrategyOutcomeRow } from './types'

function outcome(partial: Partial<StrategyOutcomeRow>): StrategyOutcomeRow {
  return {
    id: '1',
    strategy_id: 'mcap_first_seen',
    domain: 'mcap_tracker',
    token_address: 'mint',
    entry_at: '2026-01-01T00:00:00Z',
    exit_at: '2026-01-01T02:00:00Z',
    pnl_pct: 80,
    status: 'won',
    is_simulated: true,
    features: {},
    created_at: '2026-01-01T02:00:00Z',
    ...partial,
  }
}

describe('extractMlFeatureVector', () => {
  it('builds numeric vector with band one-hot', () => {
    const vector = extractMlFeatureVector({
      entry_mcap: 100_000,
      entry_mcap_band: '51-100k',
      organic_score: 70,
      top_holders_pct: 12,
      token_age_hours: 1.5,
      volume_at_entry: 5000,
      entry_template: 'first_seen',
    })
    expect(vector).not.toBeNull()
    expect(vector!['band_51-100k']).toBe(1)
    expect(vector!['band_under50k']).toBe(0)
    expect(vector!.entry_template_milestone_80).toBe(0)
    expect(vector!.log_entry_mcap).toBeCloseTo(Math.log1p(100_000), 5)
  })

  it('returns null when required fields missing', () => {
    expect(extractMlFeatureVector({ entry_mcap: 100_000 })).toBeNull()
  })
})

describe('resolveEffectiveTrainingClass', () => {
  it('recomputes tier from pnl when stored class missing', () => {
    expect(
      resolveEffectiveTrainingClass({ features: {}, pnl_pct: 35, status: 'won' }, true),
    ).toBe(1)
  })
})

describe('extractMlTrainingRow', () => {
  it('returns row for tier 1 outcome with complete features', () => {
    const row = extractMlTrainingRow(
      outcome({
        pnl_pct: 35,
        features: {
          entry_mcap: 80_000,
          entry_mcap_band: '51-100k',
          organic_score: 65,
          top_holders_pct: 10,
          token_age_hours: 2,
          volume_at_entry: 3000,
          entry_template: 'milestone_80',
        },
      }),
      true,
    )
    expect(row?.training_class).toBe(1)
    expect(row?.features.entry_template_milestone_80).toBe(1)
  })

  it('skips incomplete feature rows', () => {
    expect(
      extractMlTrainingRow(outcome({ pnl_pct: 35, features: { training_class: 1, entry_mcap: 1 } }), true),
    ).toBeNull()
  })
})

describe('computeMlDatasetStats', () => {
  it('counts labeled tiers and pnl buckets', () => {
    const stats = computeMlDatasetStats([
      outcome({ pnl_pct: 35, status: 'won', features: {} }),
      outcome({ id: '2', pnl_pct: -10, status: 'lost', features: {} }),
      outcome({ id: '3', pnl_pct: 120, status: 'won', features: {} }),
      outcome({ id: '4', pnl_pct: null, status: null, features: {} }),
    ])
    expect(stats.labeled).toBe(3)
    expect(stats.by_class['1']).toBe(1)
    expect(stats.by_class['0']).toBe(1)
    expect(stats.by_class['3']).toBe(1)
    expect(stats.by_gate_class['1']).toBe(2)
    expect(stats.by_gate_class['0']).toBe(1)
    expect(stats.potential_tier_counts['1']).toBe(1)
    expect(stats.potential_tier_counts['3']).toBe(1)
    expect(stats.unlabeled).toBe(1)
    expect(stats.pnl_buckets.twenty_to_50).toBe(1)
    expect(stats.ready).toBe(false)
  })
})

describe('hasTrainingClass', () => {
  it('detects recomputed tiers', () => {
    expect(hasTrainingClass({ features: {}, pnl_pct: 35, status: 'won' }, true)).toBe(true)
    expect(hasTrainingClass({ features: {}, pnl_pct: null, status: null }, true)).toBe(false)
  })
})
