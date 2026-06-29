import { describe, expect, it } from 'vitest'
import { EMPTY_SOCIAL_SNAPSHOT } from './types'
import { annotateEntryFeatures, isSocialActive } from './context'

describe('isSocialActive', () => {
  it('returns true when mentions in last 30m', () => {
    expect(
      isSocialActive({
        ...EMPTY_SOCIAL_SNAPSHOT,
        telegram_mention_count_30m: 2,
      }),
    ).toBe(true)
  })

  it('returns false for empty snapshot', () => {
    expect(isSocialActive({ ...EMPTY_SOCIAL_SNAPSHOT })).toBe(false)
  })
})

describe('annotateEntryFeatures', () => {
  it('sets social_overlap and boost when active', () => {
    const ctx = {
      snapshot: { ...EMPTY_SOCIAL_SNAPSHOT, telegram_mention_count_30m: 3 },
      isActive: true,
      overlap: true,
      socialBoostScore: 15,
    }
    const out = annotateEntryFeatures({ entry_mcap: 100_000 }, ctx)
    expect(out.social_overlap).toBe(true)
    expect(out.social_boost_score).toBe(15)
    expect(out.telegram_mention_count_30m).toBe(3)
  })
})
