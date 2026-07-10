import { describe, expect, it } from 'vitest'
import { mergeNullCoreFeatures } from './resolve-entry-snapshot'

describe('mergeNullCoreFeatures', () => {
  it('fills only null core fields from rebuilt snapshot', () => {
    const merged = mergeNullCoreFeatures(
      {
        entry_mcap: 50_000,
        organic_score: null,
        top_holders_pct: 12,
        volume_at_entry: null,
        ml_skipped: 'no_model_or_incomplete_features',
      },
      {
        entry_mcap: 99_000,
        organic_score: 55,
        top_holders_pct: 99,
        token_age_hours: 2,
        volume_at_entry: 1200,
        volume_5m: 1200,
      },
    )
    expect(merged.entry_mcap).toBe(50_000)
    expect(merged.organic_score).toBe(55)
    expect(merged.top_holders_pct).toBe(12)
    expect(merged.volume_at_entry).toBe(1200)
    expect(merged.token_age_hours).toBe(2)
    expect(merged.ml_skipped).toBeUndefined()
  })
})
