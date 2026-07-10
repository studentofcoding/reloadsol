import { describe, expect, it, beforeEach } from 'vitest'
import {
  buildGmgnHotAfterEntryFields,
  computeGmgnLiveBoostScore,
  resetGmgnLiveBoostStateForTests,
} from './gmgn-live-boost'

describe('computeGmgnLiveBoostScore', () => {
  it('adds overlap and cluster bonuses', () => {
    const base = computeGmgnLiveBoostScore({ sm_wallet_count_60m: 1, kol_wallet_count_60m: 0 })
    const overlap = computeGmgnLiveBoostScore({ sm_wallet_count_60m: 2, kol_wallet_count_60m: 1 })
    expect(overlap).toBeGreaterThan(base)
  })
})

describe('buildGmgnHotAfterEntryFields', () => {
  it('computes minutes from anchor to hot event', () => {
    const fields = buildGmgnHotAfterEntryFields({
      anchorAt: '2026-07-10T12:00:00.000Z',
      hotEvent: {
        occurred_at: '2026-07-10T12:15:00.000Z',
        raw_metadata: { gmgn_activity_score: 85, sm_wallet_count_60m: 5 },
      },
      liveBoostScore: 40,
      source: 'activity_poll',
    })

    expect(fields.has_gmgn_hot_after_entry).toBe(1)
    expect(fields.minutes_entry_to_gmgn_hot).toBe(15)
    expect(fields.gmgn_activity_score_after_entry).toBe(85)
    expect(fields.gmgn_live_boost_score).toBe(40)
  })
})

describe('resetGmgnLiveBoostStateForTests', () => {
  beforeEach(() => {
    resetGmgnLiveBoostStateForTests()
  })

  it('clears toast buffer', () => {
    expect(() => resetGmgnLiveBoostStateForTests()).not.toThrow()
  })
})
