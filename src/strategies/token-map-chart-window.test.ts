import { describe, expect, it } from 'vitest'
import {
  NEW_CHART_MAX_AGE_SEC,
  NEW_CHART_SPAN_SEC,
  OLD_CHART_MAX_SPAN_SEC,
  chartWindowHours,
  chartWindowSpanSec,
  resolveFreeviewChartWindow,
} from '@/strategies/token-map-chart-window'

describe('resolveFreeviewChartWindow', () => {
  const now = 1_700_000_000

  it('empty anchors → new last 10m', () => {
    const w = resolveFreeviewChartWindow({ nowSec: now, anchorsSec: [] })
    expect(w.mode).toBe('new')
    expect(w.timeTo).toBe(now)
    expect(w.timeFrom).toBe(now - NEW_CHART_SPAN_SEC)
    expect(chartWindowSpanSec(w)).toBe(NEW_CHART_SPAN_SEC)
  })

  it('anchor 5m ago → new last 10m', () => {
    const w = resolveFreeviewChartWindow({
      nowSec: now,
      anchorsSec: [now - 5 * 60],
    })
    expect(w.mode).toBe('new')
    expect(w.timeFrom).toBe(now - NEW_CHART_SPAN_SEC)
  })

  it('anchor just under 10m → new', () => {
    const w = resolveFreeviewChartWindow({
      nowSec: now,
      anchorsSec: [now - NEW_CHART_MAX_AGE_SEC + 1],
    })
    expect(w.mode).toBe('new')
  })

  it('anchor 2h ago → old span 2h', () => {
    const anchor = now - 2 * 3600
    const w = resolveFreeviewChartWindow({
      nowSec: now,
      anchorsSec: [anchor],
    })
    expect(w.mode).toBe('old')
    expect(w.timeFrom).toBe(anchor)
    expect(w.timeTo).toBe(now)
    expect(chartWindowSpanSec(w)).toBe(2 * 3600)
  })

  it('anchor 48h ago → old capped at 24h from anchor', () => {
    const anchor = now - 48 * 3600
    const w = resolveFreeviewChartWindow({
      nowSec: now,
      anchorsSec: [anchor, now - 40 * 3600],
    })
    expect(w.mode).toBe('old')
    expect(w.timeFrom).toBe(anchor)
    expect(w.timeTo).toBe(anchor + OLD_CHART_MAX_SPAN_SEC)
    expect(chartWindowSpanSec(w)).toBe(OLD_CHART_MAX_SPAN_SEC)
  })

  it('ignores future / non-finite anchors', () => {
    const w = resolveFreeviewChartWindow({
      nowSec: now,
      anchorsSec: [Number.NaN, now + 100, 0, now - 3 * 3600],
    })
    expect(w.mode).toBe('old')
    expect(w.timeFrom).toBe(now - 3 * 3600)
  })

  it('chartWindowHours reflects span', () => {
    const w = resolveFreeviewChartWindow({ nowSec: now, anchorsSec: [] })
    expect(chartWindowHours(w)).toBeCloseTo(10 / 60, 5)
  })
})
