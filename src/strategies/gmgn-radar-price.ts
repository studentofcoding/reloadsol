/** Radar reappearance price growth → sticky WATCH / dump ban. */

import type { GmgnRadarAction } from './gmgn-radar-review'

export const RADAR_PUMP_WATCH_PCT = 50
export const RADAR_DUMP_BAN_PCT = -80

export function computeRadarPriceGrowth(
  currentUsd: number | null | undefined,
  previousUsd: number | null | undefined,
): number | null {
  if (
    currentUsd == null ||
    previousUsd == null ||
    !Number.isFinite(currentUsd) ||
    !Number.isFinite(previousUsd) ||
    previousUsd <= 0
  ) {
    return null
  }
  return ((currentUsd - previousUsd) / previousUsd) * 100
}

export type RadarPriceRuleInput = {
  action: GmgnRadarAction
  growthPct: number | null
  stickyBaselineUsd: number | null
  currentPriceUsd: number | null
  /** Previous sighting price — used as sticky baseline when pump triggers */
  previousPriceUsd: number | null
}

export type RadarPriceRuleResult = {
  action: GmgnRadarAction
  stickyBaselineUsd: number | null
  banned: boolean
  reasons: string[]
  growthPct: number | null
}

/**
 * Apply dump / sticky-pump rules after normal Radar scoring.
 * Dump: growth ≤ -80% → SKIP + banned.
 * Pump: growth > 50% → force WATCH, sticky baseline = previous price until current ≤ baseline.
 */
export function applyRadarPriceRules(input: RadarPriceRuleInput): RadarPriceRuleResult {
  const growthPct = input.growthPct
  const current = input.currentPriceUsd
  let sticky = input.stickyBaselineUsd
  const reasons: string[] = []

  if (growthPct != null && growthPct <= RADAR_DUMP_BAN_PCT) {
    return {
      action: 'SKIP',
      stickyBaselineUsd: null,
      banned: true,
      reasons: [`price dump ${growthPct.toFixed(1)}% ≤ ${RADAR_DUMP_BAN_PCT}%`],
      growthPct,
    }
  }

  // Clear sticky when back at or below baseline (growth ≤ 0% vs baseline)
  if (
    sticky != null &&
    sticky > 0 &&
    current != null &&
    Number.isFinite(current) &&
    current <= sticky
  ) {
    sticky = null
    reasons.push('cleared sticky WATCH (back to ≤0% vs baseline)')
  }

  // Still above sticky baseline → force WATCH
  if (
    sticky != null &&
    sticky > 0 &&
    current != null &&
    Number.isFinite(current) &&
    current > sticky
  ) {
    reasons.push('sticky WATCH (still above pump baseline)')
    return {
      action: 'WATCH',
      stickyBaselineUsd: sticky,
      banned: false,
      reasons,
      growthPct,
    }
  }

  // New pump vs previous sighting
  if (
    growthPct != null &&
    growthPct > RADAR_PUMP_WATCH_PCT &&
    input.previousPriceUsd != null &&
    input.previousPriceUsd > 0
  ) {
    reasons.push(
      `pump ${growthPct.toFixed(1)}% > ${RADAR_PUMP_WATCH_PCT}% — sticky WATCH`,
    )
    return {
      action: 'WATCH',
      stickyBaselineUsd: input.previousPriceUsd,
      banned: false,
      reasons,
      growthPct,
    }
  }

  return {
    action: input.action,
    stickyBaselineUsd: sticky,
    banned: false,
    reasons,
    growthPct,
  }
}

/** Read last known radar price + sticky baseline from social event metadata (newest first). */
export function extractRadarPriceStateFromEvents(
  events: Array<{ raw_metadata?: Record<string, unknown> | null }>,
): {
  previousPriceUsd: number | null
  stickyBaselineUsd: number | null
} {
  let previousPriceUsd: number | null = null
  let stickyBaselineUsd: number | null = null

  for (const event of events) {
    const meta =
      event.raw_metadata && typeof event.raw_metadata === 'object'
        ? event.raw_metadata
        : {}
    if (previousPriceUsd == null) {
      const p = meta.radar_price_usd
      if (typeof p === 'number' && Number.isFinite(p) && p > 0) {
        previousPriceUsd = p
      }
    }
    if (stickyBaselineUsd == null) {
      const b = meta.radar_watch_baseline_usd
      if (typeof b === 'number' && Number.isFinite(b) && b > 0) {
        stickyBaselineUsd = b
      }
    }
    if (previousPriceUsd != null && stickyBaselineUsd != null) break
  }

  return { previousPriceUsd, stickyBaselineUsd }
}
