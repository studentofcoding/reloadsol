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
