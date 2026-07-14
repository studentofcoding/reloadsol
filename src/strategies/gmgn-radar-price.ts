/** Radar reappearance price growth → sticky WATCH / dump ban. */

import type { GmgnRadarAction } from './gmgn-radar-review'

export const RADAR_PUMP_WATCH_PCT = 50
export const RADAR_DUMP_BAN_PCT = -80
export const RADAR_STICKY_TTL_MINUTES = 45
export const RADAR_ENTER_OVERRIDE_MIN_SCORE = 55

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
  /** Pre-sticky Radar score (0–100) for ENTER override. */
  radarScore?: number | null
  growthPct: number | null
  stickyBaselineUsd: number | null
  /** ISO when sticky first armed. */
  stickySinceIso?: string | null
  currentPriceUsd: number | null
  /** Previous sighting price — used as sticky baseline when pump triggers */
  previousPriceUsd: number | null
  stickyPumpPct?: number
  dumpBanPct?: number
  stickyTtlMinutes?: number
  enterOverrideMinScore?: number
  nowMs?: number
}

export type RadarPriceRuleResult = {
  action: GmgnRadarAction
  stickyBaselineUsd: number | null
  stickySinceIso: string | null
  banned: boolean
  reasons: string[]
  growthPct: number | null
}

/**
 * Apply dump / sticky-pump rules after normal Radar scoring.
 * Dump: growth ≤ dumpBanPct → SKIP + banned.
 * Pump: growth > stickyPumpPct → force WATCH until ≤ baseline, TTL expiry, or score override.
 */
export function applyRadarPriceRules(input: RadarPriceRuleInput): RadarPriceRuleResult {
  const growthPct = input.growthPct
  const current = input.currentPriceUsd
  let sticky = input.stickyBaselineUsd
  let stickySinceIso = input.stickySinceIso ?? null
  const reasons: string[] = []
  const dumpBanPct = input.dumpBanPct ?? RADAR_DUMP_BAN_PCT
  const stickyPumpPct = input.stickyPumpPct ?? RADAR_PUMP_WATCH_PCT
  const stickyTtlMinutes = input.stickyTtlMinutes ?? RADAR_STICKY_TTL_MINUTES
  const enterOverrideMinScore =
    input.enterOverrideMinScore ?? RADAR_ENTER_OVERRIDE_MIN_SCORE
  const nowMs = input.nowMs ?? Date.now()
  const radarScore =
    typeof input.radarScore === 'number' && Number.isFinite(input.radarScore)
      ? input.radarScore
      : null

  if (growthPct != null && growthPct <= dumpBanPct) {
    return {
      action: 'SKIP',
      stickyBaselineUsd: null,
      stickySinceIso: null,
      banned: true,
      reasons: [`price dump ${growthPct.toFixed(1)}% ≤ ${dumpBanPct}%`],
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
    stickySinceIso = null
    reasons.push('cleared sticky WATCH (back to ≤0% vs baseline)')
  }

  const stickyActive =
    sticky != null &&
    sticky > 0 &&
    current != null &&
    Number.isFinite(current) &&
    current > sticky

  if (stickyActive) {
    const sinceMs = stickySinceIso ? Date.parse(stickySinceIso) : NaN
    const ageMs = Number.isFinite(sinceMs) ? nowMs - sinceMs : 0
    const ttlMs = Math.max(0, stickyTtlMinutes) * 60_000

    if (ttlMs > 0 && Number.isFinite(sinceMs) && ageMs >= ttlMs) {
      reasons.push(
        `sticky TTL expired (${stickyTtlMinutes}m) — allow scored action`,
      )
      return {
        action: input.action,
        stickyBaselineUsd: null,
        stickySinceIso: null,
        banned: false,
        reasons,
        growthPct,
      }
    }

    if (radarScore != null && radarScore >= enterOverrideMinScore) {
      reasons.push(
        `sticky override score ${radarScore}≥${enterOverrideMinScore}`,
      )
      return {
        action: input.action,
        stickyBaselineUsd: sticky,
        stickySinceIso: stickySinceIso || new Date(nowMs).toISOString(),
        banned: false,
        reasons,
        growthPct,
      }
    }

    reasons.push('sticky WATCH (still above pump baseline)')
    return {
      action: 'WATCH',
      stickyBaselineUsd: sticky,
      stickySinceIso: stickySinceIso || new Date(nowMs).toISOString(),
      banned: false,
      reasons,
      growthPct,
    }
  }

  // New pump vs previous sighting
  if (
    growthPct != null &&
    growthPct > stickyPumpPct &&
    input.previousPriceUsd != null &&
    input.previousPriceUsd > 0
  ) {
    if (radarScore != null && radarScore >= enterOverrideMinScore) {
      reasons.push(
        `pump ${growthPct.toFixed(1)}% > ${stickyPumpPct}% — sticky override score ${radarScore}≥${enterOverrideMinScore}`,
      )
      return {
        action: input.action,
        stickyBaselineUsd: input.previousPriceUsd,
        stickySinceIso: new Date(nowMs).toISOString(),
        banned: false,
        reasons,
        growthPct,
      }
    }
    reasons.push(
      `pump ${growthPct.toFixed(1)}% > ${stickyPumpPct}% — sticky WATCH`,
    )
    return {
      action: 'WATCH',
      stickyBaselineUsd: input.previousPriceUsd,
      stickySinceIso: new Date(nowMs).toISOString(),
      banned: false,
      reasons,
      growthPct,
    }
  }

  return {
    action: input.action,
    stickyBaselineUsd: sticky,
    stickySinceIso: sticky != null && sticky > 0 ? stickySinceIso : null,
    banned: false,
    reasons,
    growthPct,
  }
}

/** Read last known radar price / mcap + sticky baseline from social event metadata (newest first). */
export function extractRadarPriceStateFromEvents(
  events: Array<{ raw_metadata?: Record<string, unknown> | null }>,
): {
  previousPriceUsd: number | null
  previousMcapUsd: number | null
  stickyBaselineUsd: number | null
  stickySinceIso: string | null
} {
  let previousPriceUsd: number | null = null
  let previousMcapUsd: number | null = null
  let stickyBaselineUsd: number | null = null
  let stickySinceIso: string | null = null

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
    if (previousMcapUsd == null) {
      const m = meta.radar_mcap_usd
      if (typeof m === 'number' && Number.isFinite(m) && m > 0) {
        previousMcapUsd = m
      }
    }
    if (stickyBaselineUsd == null) {
      const b = meta.radar_watch_baseline_usd
      if (typeof b === 'number' && Number.isFinite(b) && b > 0) {
        stickyBaselineUsd = b
      }
    }
    if (stickySinceIso == null) {
      const s = meta.radar_sticky_since_iso
      if (typeof s === 'string' && s.trim() !== '' && Number.isFinite(Date.parse(s))) {
        stickySinceIso = s
      }
    }
    if (
      previousPriceUsd != null &&
      previousMcapUsd != null &&
      stickyBaselineUsd != null &&
      stickySinceIso != null
    ) {
      break
    }
  }

  return { previousPriceUsd, previousMcapUsd, stickyBaselineUsd, stickySinceIso }
}
