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
  applyAutoLabelsFromMilestones,
  applyMcapSessionUpdates,
  reconcileMilestonesFromGrowth,
  resetTrackingSession,
  updatePeakMcap,
  type McapSnapshot,
} from './mcap-tracker'

function row(overrides: Partial<McapSnapshot> = {}): McapSnapshot {
  return {
    token_address: 'mint1',
    token_symbol: 'TEST',
    first_mcap: 100_000,
    current_mcap: 100_000,
    first_seen_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    last_updated_at: new Date().toISOString(),
    mcap_growth_percent: 0,
    when_reach_80pct: null,
    when_reach_120pct: null,
    when_reach_200pct: null,
    when_drop_40pct: null,
    when_drop_80pct: null,
    peak_mcap: 100_000,
    peak_growth_percent: 0,
    peak_seen_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    is_tracking_stuck: false,
    label: null,
    ...overrides,
  }
}

describe('updatePeakMcap', () => {
  it('raises peak when current exceeds prior peak', () => {
    const record = row({ peak_mcap: 100_000, peak_growth_percent: 0 })
    const now = new Date().toISOString()
    expect(updatePeakMcap(record, 150_000, 50, now)).toBe(true)
    expect(record.peak_mcap).toBe(150_000)
    expect(record.peak_growth_percent).toBe(50)
    expect(record.peak_seen_at).toBe(now)
  })

  it('does not lower peak on pullback', () => {
    const record = row({
      peak_mcap: 200_000,
      peak_growth_percent: 100,
      peak_seen_at: '2026-07-09T00:00:00.000Z',
    })
    expect(updatePeakMcap(record, 120_000, 20, new Date().toISOString())).toBe(false)
    expect(record.peak_mcap).toBe(200_000)
    expect(record.peak_growth_percent).toBe(100)
  })
})

describe('drop milestones + auto labels', () => {
  it('stamps -40 and -80 in one crash tick and labels rugged', () => {
    const record = row({ label: 'watching' })
    const now = new Date().toISOString()
    expect(applyMcapSessionUpdates(record, 15_000, -85, now)).toBe(true)
    expect(record.when_drop_40pct).toBe(now)
    expect(record.when_drop_80pct).toBe(now)
    expect(record.label).toBe('rugged')
  })

  it('labels potential when peak growth is positive', () => {
    const record = row({ label: 'valid', peak_growth_percent: 0 })
    const now = new Date().toISOString()
    applyMcapSessionUpdates(record, 140_000, 40, now)
    expect(record.peak_growth_percent).toBe(40)
    expect(record.label).toBe('potential')
  })

  it('does not overwrite traded_live with rugged or potential', () => {
    const record = row({ label: 'traded_live' })
    const now = new Date().toISOString()
    applyMcapSessionUpdates(record, 10_000, -90, now)
    expect(record.when_drop_80pct).toBe(now)
    expect(record.label).toBe('traded_live')
  })

  it('does not downgrade rugged to potential', () => {
    const record = row({
      label: 'rugged',
      when_drop_40pct: '2026-07-09T00:00:00.000Z',
      peak_mcap: 200_000,
      peak_growth_percent: 100,
    })
    expect(applyAutoLabelsFromMilestones(record)).toBe(false)
    expect(record.label).toBe('rugged')
  })

  it('reconcile backfills drop milestones from growth', () => {
    const record = row({ mcap_growth_percent: -45 })
    const t = new Date().toISOString()
    expect(reconcileMilestonesFromGrowth(record, t)).toBe(true)
    expect(record.when_drop_40pct).toBe(t)
    expect(record.when_drop_80pct).toBeNull()
  })

  it('reset clears drop and peak fields', () => {
    const record = row({
      when_drop_40pct: '2026-07-09T00:00:00.000Z',
      peak_mcap: 300_000,
      peak_growth_percent: 200,
    })
    const now = new Date().toISOString()
    resetTrackingSession(record, 50_000, now)
    expect(record.when_drop_40pct).toBeNull()
    expect(record.peak_mcap).toBe(50_000)
    expect(record.peak_growth_percent).toBe(0)
  })
})
