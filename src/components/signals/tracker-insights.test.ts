import { describe, expect, it } from 'vitest'
import {
  deriveTrackerTokenInsights,
  formatScore0To100,
  formatTrackingAge,
  riskLabelFromScore,
} from './tracker-insights'
import type { McapTrackingData } from '@/hooks/useMCapTracker'

describe('formatScore0To100', () => {
  it('formats 0-100 without percent suffix', () => {
    expect(formatScore0To100(72)).toBe('72/100')
    expect(formatScore0To100(8000)).toBe('100/100')
  })

  it('returns dash for invalid', () => {
    expect(formatScore0To100(null)).toBe('—')
  })
})

describe('deriveTrackerTokenInsights', () => {
  const token: McapTrackingData = {
    token_address: 'a',
    token_symbol: 'ALONE',
    first_mcap: 35_000,
    current_mcap: 138_000,
    first_seen_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    last_updated_at: new Date().toISOString(),
    mcap_growth_percent: 292,
    when_reach_80pct: new Date(Date.now() - 30 * 60_000).toISOString(),
    when_reach_120pct: new Date(Date.now() - 20 * 60_000).toISOString(),
    when_reach_200pct: null,
    solPerToken: { first: 1, current: 2, growth: 100 },
  }

  it('counts milestones only when growth supports them', () => {
    const insights = deriveTrackerTokenInsights(token)
    expect(insights.milestonesReached).toBe(2)
    expect(insights.riskLabel).toBe(riskLabelFromScore(insights.riskScore))
    expect(formatTrackingAge(insights.trackingAgeHours)).toMatch(/h|m/)
  })
})
