import { describe, expect, it } from 'vitest'
import {
  computeMlDatasetStats,
  extractMlFeatureVector,
  extractMlTrainingRow,
  hasTrainingClass,
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

describe('extractMlTrainingRow', () => {
  it('returns row for labeled outcome with complete features', () => {
    const row = extractMlTrainingRow(
      outcome({
        features: {
          training_class: 1,
          entry_mcap: 80_000,
          entry_mcap_band: '51-100k',
          organic_score: 65,
          top_holders_pct: 10,
          token_age_hours: 2,
          volume_at_entry: 3000,
          entry_template: 'milestone_80',
        },
      }),
    )
    expect(row?.training_class).toBe(1)
    expect(row?.features.entry_template_milestone_80).toBe(1)
  })

  it('skips marginal or incomplete rows', () => {
    expect(extractMlTrainingRow(outcome({ features: { training_class: null } }))).toBeNull()
    expect(
      extractMlTrainingRow(outcome({ features: { training_class: 1, entry_mcap: 1 } })),
    ).toBeNull()
  })
})

describe('computeMlDatasetStats', () => {
  it('counts labeled, marginal, and readiness', () => {
    const stats = computeMlDatasetStats([
      outcome({ features: { training_class: 1 } }),
      outcome({ id: '2', features: { training_class: 0 } }),
      outcome({ id: '3', pnl_pct: 30, features: {} }),
      outcome({ id: '4', pnl_pct: null, features: {} }),
    ])
    expect(stats.labeled).toBe(2)
    expect(stats.class_1).toBe(1)
    expect(stats.class_0).toBe(1)
    expect(stats.marginal).toBe(1)
    expect(stats.unlabeled).toBe(1)
    expect(stats.ready).toBe(false)
  })
})

describe('hasTrainingClass', () => {
  it('detects 0/1 only', () => {
    expect(hasTrainingClass({ training_class: 1 })).toBe(true)
    expect(hasTrainingClass({ training_class: 0 })).toBe(true)
    expect(hasTrainingClass({ training_class: null })).toBe(false)
  })
})
