import { describe, expect, it } from 'vitest'
import {
  analyticsHasLastUpdatedCutoff,
  analyticsMaxAgeFromTimeFilter,
  buildMcapAnalyticsSql,
  classifyAnalyticsMissing,
  resolveAnalyticsMaxAge,
  usdPricesToAnalyticsMap,
} from './analytics-helpers'

describe('analyticsMaxAgeFromTimeFilter', () => {
  it('maps list timeFilter including all → 0', () => {
    expect(analyticsMaxAgeFromTimeFilter('all')).toBe(0)
    expect(analyticsMaxAgeFromTimeFilter('1h')).toBe(60)
    expect(analyticsMaxAgeFromTimeFilter('4h')).toBe(240)
    expect(analyticsMaxAgeFromTimeFilter('24h')).toBe(1440)
    expect(analyticsMaxAgeFromTimeFilter('3d')).toBe(4320)
    expect(analyticsMaxAgeFromTimeFilter('7d')).toBe(10080)
    expect(analyticsMaxAgeFromTimeFilter('1m')).toBe(43200)
  })
})

describe('resolveAnalyticsMaxAge / cutoff', () => {
  it('defaults omitted maxAge to 60 and treats 0 as no cutoff', () => {
    expect(resolveAnalyticsMaxAge(undefined)).toBe(60)
    expect(resolveAnalyticsMaxAge(0)).toBe(0)
    expect(analyticsHasLastUpdatedCutoff(60)).toBe(true)
    expect(analyticsHasLastUpdatedCutoff(0)).toBe(false)
    expect(buildMcapAnalyticsSql(0).hasCutoff).toBe(false)
    expect(buildMcapAnalyticsSql(0).sql).not.toMatch(/last_updated_at/)
    expect(buildMcapAnalyticsSql(60).hasCutoff).toBe(true)
    expect(buildMcapAnalyticsSql(60).sql).toMatch(/last_updated_at >= \$2/)
  })
})

describe('classifyAnalyticsMissing', () => {
  const now = Date.parse('2026-09-21T12:00:00.000Z')

  it('marks unknown mints not_found and stale rows stale', () => {
    const missing = classifyAnalyticsMissing(
      ['fresh', 'old', 'ghost'],
      [
        { token_address: 'fresh', last_updated_at: '2026-09-21T11:30:00.000Z' },
        { token_address: 'old', last_updated_at: '2026-09-21T10:00:00.000Z' },
      ],
      ['fresh'],
      60,
      now,
    )
    expect(missing).toEqual([
      { token_address: 'old', reason: 'stale' },
      { token_address: 'ghost', reason: 'not_found' },
    ])
  })

  it('marks fresh-but-unenriched as dropped', () => {
    const missing = classifyAnalyticsMissing(
      ['a'],
      [{ token_address: 'a', last_updated_at: '2026-09-21T11:50:00.000Z' }],
      [],
      60,
      now,
    )
    expect(missing).toEqual([{ token_address: 'a', reason: 'dropped' }])
  })
})

describe('usdPricesToAnalyticsMap', () => {
  it('drops non-positive prices', () => {
    expect(
      usdPricesToAnalyticsMap({ a: 1.2, b: 0, c: Number.NaN }),
    ).toEqual({ a: { price: 1.2 } })
  })
})
