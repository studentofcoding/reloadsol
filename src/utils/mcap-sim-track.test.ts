import { describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

vi.mock('@/utils/unified-logger', () => ({
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { MCAP_TRACKER_STRATEGIES } from '@/strategies/registry'
import {
  evaluateLiveEntryBrake,
  liveTrackerMaxRatio,
  getMcapSimOpenSkipReason,
  resolveMcapSimEntry,
  shouldOpenMcapSim,
} from '@/utils/mcap-sim-track'
import type { McapSnapshot } from '@/utils/mcap-tracker'

function row(overrides: Partial<McapSnapshot> = {}): McapSnapshot {
  const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString()
  return {
    token_address: 'mint1',
    token_symbol: 'TEST',
    first_mcap: 35_000,
    current_mcap: 138_000,
    first_seen_at: oneHourAgo,
    last_updated_at: new Date().toISOString(),
    mcap_growth_percent: 292,
    when_reach_80pct: null,
    when_reach_120pct: null,
    when_reach_200pct: null,
    is_tracking_stuck: false,
    ...overrides,
  }
}

describe('mcap sim entry helpers', () => {
  const at80 = MCAP_TRACKER_STRATEGIES.mcap_enter_at_80
  const firstSeen = MCAP_TRACKER_STRATEGIES.mcap_enter_first_seen

  it('timely milestone_80 books live current_mcap at open time', () => {
    const milestoneAt = new Date(Date.now() - 30 * 60_000).toISOString()
    const lastUpdated = new Date().toISOString()
    const snapshot = row({
      when_reach_80pct: milestoneAt,
      mcap_growth_percent: 95,
      current_mcap: 200_000,
      last_updated_at: lastUpdated,
    })
    expect(shouldOpenMcapSim(at80, snapshot, new Set())).toBe(true)
    const entry = resolveMcapSimEntry(at80, snapshot)
    expect(entry?.entryMcap).toBe(200_000)
    expect(entry?.entryAt).toBe(lastUpdated)
  })

  it('within recency, no milestone stamp: entry uses current_mcap', () => {
    const snapshot = row({
      when_reach_80pct: null,
      mcap_growth_percent: 292,
      current_mcap: 138_000,
      first_seen_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    })
    expect(shouldOpenMcapSim(at80, snapshot, new Set())).toBe(true)
    const entry = resolveMcapSimEntry(at80, snapshot)
    expect(entry?.entryMcap).toBe(138_000)
  })

  it('skips milestone_80 when growth below threshold and no milestone', () => {
    const snapshot = row({ when_reach_80pct: null, mcap_growth_percent: 50 })
    expect(getMcapSimOpenSkipReason(at80, snapshot, new Set())).toBe('no_milestone')
  })

  it('skips first_seen when token is too old', () => {
    const oldFirst = new Date(Date.now() - 300 * 60_000).toISOString()
    const snapshot = row({ first_seen_at: oldFirst })
    expect(getMcapSimOpenSkipReason(firstSeen, snapshot, new Set())).toBe(
      'first_seen_too_old',
    )
  })

  it('skips stale milestone_80 when when_reach_80pct is older than recency', () => {
    const oldMilestone = new Date(Date.now() - 12 * 60 * 60_000).toISOString()
    const snapshot = row({
      when_reach_80pct: oldMilestone,
      mcap_growth_percent: 292,
      current_mcap: 500_000,
      first_seen_at: new Date(Date.now() - 13 * 60 * 60_000).toISOString(),
    })
    expect(getMcapSimOpenSkipReason(at80, snapshot, new Set())).toBe(
      'milestone_too_old',
    )
    expect(shouldOpenMcapSim(at80, snapshot, new Set())).toBe(false)
  })

  it('skips late growth-only open when first_seen is older than recency (SAPIJIJU case)', () => {
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60_000).toISOString()
    const snapshot = row({
      when_reach_80pct: null,
      mcap_growth_percent: 292,
      first_mcap: 75_200,
      current_mcap: 478_000,
      first_seen_at: twelveHoursAgo,
    })
    expect(getMcapSimOpenSkipReason(at80, snapshot, new Set())).toBe(
      'milestone_too_old',
    )
    // Would have been fake first*1.8 ≈ 135K — must not open
    expect(shouldOpenMcapSim(at80, snapshot, new Set())).toBe(false)
  })

  it('skips out_of_range tokens by entry mcap', () => {
    const snapshot = row({
      first_mcap: 5_000,
      current_mcap: 5_000,
      mcap_growth_percent: 292,
      when_reach_80pct: new Date().toISOString(),
    })
    expect(getMcapSimOpenSkipReason(at80, snapshot, new Set())).toBe('out_of_range')
  })

  it('skips when live mcap exceeds max even if first*1.8 would be in range', () => {
    const snapshot = row({
      first_mcap: 60_000,
      current_mcap: 2_500_000,
      mcap_growth_percent: 4000,
      when_reach_80pct: new Date().toISOString(),
    })
    expect(getMcapSimOpenSkipReason(at80, snapshot, new Set())).toBe('out_of_range')
    expect(resolveMcapSimEntry(at80, snapshot)?.entryMcap).toBe(2_500_000)
  })

  it('skips when mint already has a closed outcome (one-shot)', () => {
    const lastUpdated = new Date(Date.now() - 30 * 60_000).toISOString()
    const snapshot = row({
      when_reach_80pct: new Date(Date.now() - 30 * 60_000).toISOString(),
      last_updated_at: lastUpdated,
      mcap_growth_percent: 95,
    })
    const closedMints = new Set(['mint1'])
    expect(
      getMcapSimOpenSkipReason(at80, snapshot, new Set(), closedMints),
    ).toBe('already_closed')
  })

  it('still skips after last_updated_at advances when mint is closed', () => {
    const milestone = new Date(Date.now() - 30 * 60_000).toISOString()
    const snapshotT0 = row({
      when_reach_80pct: milestone,
      last_updated_at: milestone,
      mcap_growth_percent: 95,
    })
    const snapshotT1 = row({
      when_reach_80pct: milestone,
      last_updated_at: new Date().toISOString(),
      mcap_growth_percent: 95,
    })
    const closedMints = new Set(['mint1'])
    expect(getMcapSimOpenSkipReason(at80, snapshotT0, new Set(), closedMints)).toBe(
      'already_closed',
    )
    expect(getMcapSimOpenSkipReason(at80, snapshotT1, new Set(), closedMints)).toBe(
      'already_closed',
    )
    expect(getMcapSimOpenSkipReason(at80, snapshotT1, new Set(), new Set())).toBeNull()
  })
})

describe('evaluateLiveEntryBrake (skip-only sanity brake on the live Jupiter entry)', () => {
  const snap = { current_mcap: 400_000, first_mcap: 187_000 }

  it('passes a live value that agrees with the tracker', () => {
    expect(evaluateLiveEntryBrake({ liveMcap: 410_000, snapshot: snap })).toBeNull()
    expect(evaluateLiveEntryBrake({ liveMcap: 150_000, snapshot: snap })).toBeNull() // 2.7x, under 5x
  })

  it('skips the INU/QUANT shape: live ~4k vs tracker ~400k (also below the 30k band)', () => {
    const b = evaluateLiveEntryBrake({ liveMcap: 3_970, snapshot: snap })
    expect(b?.reason).toBe('live_mcap_out_of_range')
  })

  it('skips a mismatch even when the live value is inside the band', () => {
    const b = evaluateLiveEntryBrake({ liveMcap: 60_000, snapshot: snap }) // 6.7x below
    expect(b).toMatchObject({ reason: 'live_tracker_mcap_mismatch', trackerMcap: 400_000 })
    expect((b as { ratio: number }).ratio).toBeCloseTo(6.67, 1)
    expect(evaluateLiveEntryBrake({ liveMcap: 1_900_000, snapshot: { current_mcap: 300_000, first_mcap: 1 } })).toMatchObject({
      reason: 'live_tracker_mcap_mismatch',
    })
  })

  it('re-runs the band on the live value, using the strategy bounds when given', () => {
    expect(evaluateLiveEntryBrake({ liveMcap: 2_500_000, snapshot: { current_mcap: 2_400_000, first_mcap: 1 } })?.reason).toBe(
      'live_mcap_out_of_range',
    )
    expect(
      evaluateLiveEntryBrake({
        liveMcap: 2_500_000,
        snapshot: { current_mcap: 2_400_000, first_mcap: 1 },
        entry: { mcapMax: 5_000_000 },
      }),
    ).toBeNull()
  })

  it('falls back to first_mcap, and applies only the band when the tracker has nothing', () => {
    expect(evaluateLiveEntryBrake({ liveMcap: 50_000, snapshot: { current_mcap: 0, first_mcap: 40_000 } })).toBeNull()
    expect(evaluateLiveEntryBrake({ liveMcap: 50_000, snapshot: { current_mcap: 0, first_mcap: 5_000 } })?.reason).toBe(
      'live_tracker_mcap_mismatch',
    )
    expect(evaluateLiveEntryBrake({ liveMcap: 50_000, snapshot: { current_mcap: 0, first_mcap: 0 } })).toBeNull()
  })

  it('rejects non-finite / non-positive live values', () => {
    expect(evaluateLiveEntryBrake({ liveMcap: NaN, snapshot: snap })?.reason).toBe('live_mcap_out_of_range')
    expect(evaluateLiveEntryBrake({ liveMcap: 0, snapshot: snap })?.reason).toBe('live_mcap_out_of_range')
  })

  it('ratio is a constant, 5 by default, env-overridable, and never < 1', () => {
    expect(liveTrackerMaxRatio({})).toBe(5)
    expect(liveTrackerMaxRatio({ MCAP_LIVE_TRACKER_MAX_RATIO: '8' })).toBe(8)
    expect(liveTrackerMaxRatio({ MCAP_LIVE_TRACKER_MAX_RATIO: '1' })).toBe(5)
    expect(liveTrackerMaxRatio({ MCAP_LIVE_TRACKER_MAX_RATIO: 'abc' })).toBe(5)
    expect(evaluateLiveEntryBrake({ liveMcap: 60_000, snapshot: snap, maxRatio: 8 })).toBeNull()
  })
})
