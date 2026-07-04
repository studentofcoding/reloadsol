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

import {
  getMcapSimCloseReason,
  isTrackingTimelineInconsistent,
  normalizeTrackingTimeline,
  reconcileMilestonesFromGrowth,
  resetTrackingSession,
  type McapSnapshot,
} from './mcap-tracker'

function row(overrides: Partial<McapSnapshot> = {}): McapSnapshot {
  const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString()
  const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60_000).toISOString()
  return {
    token_address: 'mint1',
    token_symbol: 'TEST',
    first_mcap: 35_000,
    current_mcap: 138_000,
    first_seen_at: oneHourAgo,
    last_updated_at: new Date().toISOString(),
    mcap_growth_percent: 292,
    when_reach_80pct: eightHoursAgo,
    when_reach_120pct: eightHoursAgo,
    when_reach_200pct: eightHoursAgo,
    is_tracking_stuck: false,
    ...overrides,
  }
}

describe('normalizeTrackingTimeline v2', () => {
  it('clears stale milestones before first_seen without aging first_seen', () => {
    const record = row()
    const firstBefore = record.first_seen_at
    expect(normalizeTrackingTimeline(record)).toBe(true)
    expect(record.first_seen_at).toBe(firstBefore)
    expect(record.when_reach_80pct).toBeNull()
    expect(record.when_reach_120pct).toBeNull()
    expect(record.when_reach_200pct).toBeNull()
  })

  it('clears milestone that predates first_seen without aging first_seen', () => {
    const milestone = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    const lateFirst = new Date(Date.now() - 30 * 60_000).toISOString()
    const record = row({
      first_seen_at: lateFirst,
      when_reach_80pct: milestone,
      when_reach_120pct: null,
      when_reach_200pct: null,
      mcap_growth_percent: 100,
    })
    normalizeTrackingTimeline(record)
    expect(record.first_seen_at).toBe(lateFirst)
    expect(record.when_reach_80pct).toBeNull()
  })

  it('clears milestones when growth is below threshold', () => {
    const first = new Date(Date.now() - 60 * 60_000).toISOString()
    const milestone = new Date(Date.now() - 30 * 60_000).toISOString()
    const record = row({
      first_seen_at: first,
      when_reach_80pct: milestone,
      mcap_growth_percent: 10,
    })
    normalizeTrackingTimeline(record)
    expect(record.when_reach_80pct).toBeNull()
  })
})

describe('reconcileMilestonesFromGrowth', () => {
  it('restores only the lowest milestone per call after normalize clears stale data', () => {
    const record = row()
    normalizeTrackingTimeline(record)
    expect(record.when_reach_80pct).toBeNull()
    const t1 = new Date().toISOString()
    expect(reconcileMilestonesFromGrowth(record, t1)).toBe(true)
    expect(record.when_reach_80pct).toBe(t1)
    expect(record.when_reach_120pct).toBeNull()
    expect(record.when_reach_200pct).toBeNull()

    const t2 = new Date(Date.now() + 60_000).toISOString()
    expect(reconcileMilestonesFromGrowth(record, t2)).toBe(true)
    expect(record.when_reach_120pct).toBe(t2)
    expect(record.when_reach_200pct).toBeNull()

    const t3 = new Date(Date.now() + 120_000).toISOString()
    expect(reconcileMilestonesFromGrowth(record, t3)).toBe(true)
    expect(record.when_reach_200pct).toBe(t3)
    expect(reconcileMilestonesFromGrowth(record, t3)).toBe(false)
  })
})

describe('getMcapSimCloseReason', () => {
  it('returns take_profit_200 when growth >= 200', () => {
    expect(getMcapSimCloseReason(row({ mcap_growth_percent: 250 }))).toBe(
      'take_profit_200',
    )
  })

  it('returns tracking_stopped when stop_reason is set', () => {
    expect(getMcapSimCloseReason(row({ stop_reason: 'loss' }))).toBe(
      'tracking_stopped',
    )
  })
})

describe('resetTrackingSession', () => {
  it('resets baseline and clears milestones', () => {
    const now = new Date().toISOString()
    const record = row()
    resetTrackingSession(record, 50_000, now)
    expect(record.first_mcap).toBe(50_000)
    expect(record.first_seen_at).toBe(now)
    expect(record.mcap_growth_percent).toBe(0)
    expect(record.when_reach_80pct).toBeNull()
  })
})

describe('isTrackingTimelineInconsistent', () => {
  it('detects first_seen after milestone', () => {
    const milestone = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    const lateFirst = new Date(Date.now() - 30 * 60_000).toISOString()
    expect(
      isTrackingTimelineInconsistent(
        row({ first_seen_at: lateFirst, when_reach_80pct: milestone, mcap_growth_percent: 100 }),
      ),
    ).toBe(true)
  })
})
