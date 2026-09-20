import { describe, expect, it } from 'vitest'
import {
  computeRiskScore,
  deriveTrackerTokenInsights,
  formatScore0To100,
  formatTrackerDecisionLine,
  formatTrackingAge,
  matchesTrackerAnalyticsFilters,
  overlayPageCohortAnalytics,
  pageCohortAnomalies,
  resolveFilterMomentum,
  riskLabelFromScore,
  DEFAULT_TRACKER_ANALYTICS_FILTERS,
} from './tracker-insights'
import type { McapTrackingData } from '@/hooks/useMCapTracker'
import type { EnrichedTokenData } from '@/utils/data-aggregation'

function baseToken(overrides: Partial<McapTrackingData> = {}): McapTrackingData {
  return {
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
    ...overrides,
  }
}

describe('formatScore0To100', () => {
  it('formats 0-100 without percent suffix', () => {
    expect(formatScore0To100(72)).toBe('72/100')
    expect(formatScore0To100(8000)).toBe('100/100')
  })

  it('returns dash-per-100 for invalid / thin', () => {
    expect(formatScore0To100(null)).toBe('—/100')
  })
})

describe('computeRiskScore / thin data', () => {
  it('thin data (no price or volume) → Unknown, not High 100', () => {
    const token = baseToken({ current_mcap: 20_000 })
    expect(computeRiskScore(token)).toBeNull()
    const insights = deriveTrackerTokenInsights(token)
    expect(insights.dataQuality).toBe('thin')
    expect(insights.riskScore).toBeNull()
    expect(insights.riskLabel).toBe('Unknown')
    expect(insights.riskLabel).not.toBe('High')
    expect(formatScore0To100(insights.riskScore)).toBe('—/100')
  })

  it('does not treat low mcap alone as High when price/volume missing', () => {
    const token = baseToken({ current_mcap: 8_000, _live_price_usd: 0 })
    const analytics = {
      token_address: 'a',
      token_symbol: 'ALONE',
      first_mcap: 8_000,
      current_mcap: 8_000,
      mcap_growth_percent: 0,
      first_seen_at: token.first_seen_at,
      last_updated_at: token.last_updated_at,
      current_price_usd: 0,
    } as EnrichedTokenData
    const insights = deriveTrackerTokenInsights(token, analytics)
    expect(insights.dataQuality).toBe('thin')
    expect(insights.riskScore).toBeNull()
    expect(insights.riskLabel).toBe('Unknown')
  })

  it('low mcap adds risk only when price or volume is present', () => {
    const token = baseToken({ current_mcap: 20_000, mcap_growth_percent: 10 })
    const withPrice = deriveTrackerTokenInsights(token, {
      current_price_usd: 0.00012,
    } as EnrichedTokenData)
    expect(withPrice.dataQuality).toBe('ok')
    expect(withPrice.riskScore).not.toBeNull()
    expect(withPrice.riskScore as number).toBeGreaterThanOrEqual(70)
    expect(withPrice.riskLabel).toBe('High')

    const withVolOnly = deriveTrackerTokenInsights(token, {
      current_price_usd: 0,
      volume_24h: 5_000,
    } as EnrichedTokenData)
    expect(withVolOnly.dataQuality).toBe('ok')
    expect(withVolOnly.riskScore).not.toBeNull()
  })
})

describe('deriveTrackerTokenInsights decisions', () => {
  const nowMs = Date.parse('2026-09-21T12:00:00.000Z')

  it('drop stamp → skip', () => {
    const insights = deriveTrackerTokenInsights(
      baseToken({
        when_drop_40pct: '2026-09-21T11:50:00.000Z',
        first_seen_at: '2026-09-21T11:40:00.000Z',
      }),
      { current_price_usd: 0.01 } as EnrichedTokenData,
      { combined: 0.9, nowMs },
    )
    expect(insights.decision).toBe('skip')
    expect(insights.reason).toContain('dropped −40%')
    expect(insights.rugSignal).toBe(true)
    expect(insights.milestoneLabels).toContain('-40%')
  })

  it('age ≤45m + combined 0.5 → catch', () => {
    const insights = deriveTrackerTokenInsights(
      baseToken({
        first_seen_at: '2026-09-21T11:40:00.000Z',
        when_drop_40pct: null,
        when_drop_80pct: null,
        mcap_growth_percent: 20,
      }),
      { current_price_usd: 0.01 } as EnrichedTokenData,
      { combined: 0.5, nowMs },
    )
    expect(insights.trackingAgeHours * 60).toBeLessThanOrEqual(45)
    expect(insights.decision).toBe('catch')
    expect(formatTrackerDecisionLine(insights)).toMatch(
      /Decision: catch — first_seen \d+m · combined 0\.50/,
    )
  })

  it('thin data + age > 30m → skip', () => {
    const insights = deriveTrackerTokenInsights(
      baseToken({ first_seen_at: '2026-09-21T11:00:00.000Z' }),
      undefined,
      { nowMs },
    )
    expect(insights.dataQuality).toBe('thin')
    expect(insights.decision).toBe('skip')
    expect(insights.reason).toMatch(/thin data/)
  })

  it('combined < 0.25 when score available → skip', () => {
    const insights = deriveTrackerTokenInsights(
      baseToken({
        first_seen_at: '2026-09-21T11:40:00.000Z',
        when_drop_40pct: null,
      }),
      { current_price_usd: 0.01 } as EnrichedTokenData,
      { combined: 0.18, nowMs },
    )
    expect(insights.decision).toBe('skip')
    expect(insights.reason).toBe('combined 0.18')
  })

  it('counts milestones only when growth supports them', () => {
    const insights = deriveTrackerTokenInsights(baseToken())
    expect(insights.milestonesReached).toBe(2)
    expect(insights.riskLabel).toBe(riskLabelFromScore(insights.riskScore))
    expect(formatTrackingAge(insights.trackingAgeHours)).toMatch(/h|m/)
  })

  it('includes drop and peak labels in milestone list', () => {
    const insights = deriveTrackerTokenInsights({
      ...baseToken(),
      when_drop_40pct: new Date().toISOString(),
      peak_growth_percent: 150,
      peak_seen_at: new Date().toISOString(),
    })
    expect(insights.milestoneLabels).toContain('-40%')
    expect(insights.milestoneLabels.some((l) => l.startsWith('peak'))).toBe(true)
  })

  it('shows momentum unknown when analytics are thin, not negative', () => {
    const insights = deriveTrackerTokenInsights(
      baseToken({ mcap_growth_percent: -40 }),
    )
    expect(insights.dataQuality).toBe('thin')
    expect(insights.momentumLabel).toBe('unknown')
    expect(insights.liquidityLabel).toBe('unknown')
  })
})

describe('Tracker analytics filters', () => {
  it('defaults show every row', () => {
    const token = baseToken({ mcap_growth_percent: 20 })
    const insights = deriveTrackerTokenInsights(token)
    expect(
      matchesTrackerAnalyticsFilters(
        { token, insights },
        DEFAULT_TRACKER_ANALYTICS_FILTERS,
      ),
    ).toBe(true)
  })

  it('momentum explosive hides weak list rows using growth only', () => {
    const explosive = baseToken({
      token_address: 'exp',
      mcap_growth_percent: 1200,
    })
    const weak = baseToken({ token_address: 'weak', mcap_growth_percent: 20 })
    const filters = {
      ...DEFAULT_TRACKER_ANALYTICS_FILTERS,
      momentumLabels: ['explosive' as const],
    }
    expect(
      matchesTrackerAnalyticsFilters(
        { token: explosive, insights: deriveTrackerTokenInsights(explosive) },
        filters,
      ),
    ).toBe(true)
    expect(
      matchesTrackerAnalyticsFilters(
        { token: weak, insights: deriveTrackerTokenInsights(weak) },
        filters,
      ),
    ).toBe(false)
    expect(resolveFilterMomentum(weak)).toBe('weak')
  })

  it('Z |z| ≥ 2.5 keeps only finite matching Z', () => {
    const token = baseToken()
    const withZ = deriveTrackerTokenInsights(token, {
      z_score: 3.1,
      z_score_available: true,
      anomaly_type: 'positive',
      current_price_usd: 0.01,
    } as EnrichedTokenData)
    const noZ = deriveTrackerTokenInsights(token)
    const filters = {
      ...DEFAULT_TRACKER_ANALYTICS_FILTERS,
      zPreset: 'abs_2_5' as const,
    }
    expect(matchesTrackerAnalyticsFilters({ token, insights: withZ }, filters)).toBe(
      true,
    )
    expect(matchesTrackerAnalyticsFilters({ token, insights: noZ }, filters)).toBe(
      false,
    )
  })

  it('Risk Unknown keeps thin-data rows', () => {
    const token = baseToken()
    const insights = deriveTrackerTokenInsights(token)
    expect(insights.riskLabel).toBe('Unknown')
    expect(
      matchesTrackerAnalyticsFilters(
        { token, insights },
        { ...DEFAULT_TRACKER_ANALYTICS_FILTERS, riskLabels: ['Unknown'] },
      ),
    ).toBe(true)
    expect(
      matchesTrackerAnalyticsFilters(
        { token, insights },
        { ...DEFAULT_TRACKER_ANALYTICS_FILTERS, riskLabels: ['High'] },
      ),
    ).toBe(false)
  })

  it('page-cohort Z unblocks filters when analytics POST is missing', () => {
    const tokens = [
      baseToken({ token_address: 'a', mcap_growth_percent: 10 }),
      baseToken({ token_address: 'b', mcap_growth_percent: 12 }),
      baseToken({ token_address: 'c', mcap_growth_percent: 11 }),
      baseToken({ token_address: 'd', mcap_growth_percent: 9 }),
      baseToken({ token_address: 'e', mcap_growth_percent: 400 }),
    ]
    const cohort = pageCohortAnomalies(tokens)
    const outlier = overlayPageCohortAnalytics(tokens[4], undefined, cohort)
    expect(outlier?.z_score_available).toBe(true)
    const insights = deriveTrackerTokenInsights(tokens[4], outlier)
    expect(insights.zScoreAvailable).toBe(true)
    expect(insights.anomalyType).not.toBeNull()
  })
})

