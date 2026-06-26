import { describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/supabase', () => ({
  supabase: { from: vi.fn() },
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
    when_reach_80mc: null,
    when_reach_120mc: null,
    when_reach_200mc: null,
    is_tracking_stuck: false,
    ...overrides,
  }
}

describe('mcap sim entry helpers', () => {
  const at80 = MCAP_TRACKER_STRATEGIES.mcap_enter_at_80
  const firstSeen = MCAP_TRACKER_STRATEGIES.mcap_enter_first_seen

  it('allows milestone_80 entry when growth >= 80 without milestone column', () => {
    const snapshot = row({ when_reach_80mc: null, mcap_growth_percent: 292 })
    expect(shouldOpenMcapSim(at80, snapshot, new Set())).toBe(true)
    const entry = resolveMcapSimEntry(at80, snapshot)
    expect(entry?.entryMcap).toBe(Math.round(35_000 * 1.8))
    expect(entry?.entryAt).toBeTruthy()
  })

  it('skips milestone_80 when growth below threshold and no milestone', () => {
    const snapshot = row({ when_reach_80mc: null, mcap_growth_percent: 50 })
    expect(getMcapSimOpenSkipReason(at80, snapshot, new Set())).toBe('no_milestone')
  })

  it('skips first_seen when token is too old', () => {
    const oldFirst = new Date(Date.now() - 300 * 60_000).toISOString()
    const snapshot = row({ first_seen_at: oldFirst })
    expect(getMcapSimOpenSkipReason(firstSeen, snapshot, new Set())).toBe(
      'first_seen_too_old',
    )
  })

  it('skips out_of_range tokens', () => {
    const snapshot = row({ current_mcap: 5_000 })
    expect(getMcapSimOpenSkipReason(at80, snapshot, new Set())).toBe('out_of_range')
  })
})
