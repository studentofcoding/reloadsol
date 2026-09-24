/** Freeview Strategy correlation OHLC window from first strategy/activity show. */

export const NEW_CHART_MAX_AGE_SEC = 10 * 60
export const NEW_CHART_SPAN_SEC = 10 * 60
export const OLD_CHART_MAX_SPAN_SEC = 24 * 60 * 60
/** Spans at or below this skip the Redis 24h1m cold fill (one GMGN page). */
export const SHORT_OHLC_FETCH_MAX_SPAN_SEC = 15 * 60

export type FreeviewChartWindowMode = 'new' | 'old'

export type FreeviewChartWindow = {
  timeFrom: number
  timeTo: number
  mode: FreeviewChartWindowMode
}

/**
 * Anchor = earliest activity/outcome entry (unix sec).
 * New (empty or age &lt; 10m): last 10m.
 * Old: [anchor, min(anchor+24h, now)].
 */
export function resolveFreeviewChartWindow(params: {
  nowSec: number
  anchorsSec: readonly number[]
}): FreeviewChartWindow {
  const nowSec = params.nowSec
  const anchors = params.anchorsSec.filter(
    (t) => Number.isFinite(t) && t > 0 && t <= nowSec,
  )
  if (anchors.length === 0) {
    return {
      timeFrom: nowSec - NEW_CHART_SPAN_SEC,
      timeTo: nowSec,
      mode: 'new',
    }
  }
  const anchor = Math.min(...anchors)
  const age = nowSec - anchor
  if (age < NEW_CHART_MAX_AGE_SEC) {
    return {
      timeFrom: nowSec - NEW_CHART_SPAN_SEC,
      timeTo: nowSec,
      mode: 'new',
    }
  }
  return {
    timeFrom: anchor,
    timeTo: Math.min(anchor + OLD_CHART_MAX_SPAN_SEC, nowSec),
    mode: 'old',
  }
}

export function chartWindowSpanSec(w: FreeviewChartWindow): number {
  return Math.max(0, w.timeTo - w.timeFrom)
}

/** Display hours for payload / brain (min ~0.17 for 10m). */
export function chartWindowHours(w: FreeviewChartWindow): number {
  const h = chartWindowSpanSec(w) / 3600
  return Math.min(Math.max(h, 1 / 60), 168)
}
