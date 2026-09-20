import type { EnrichedTokenData } from '@/utils/data-aggregation'
import type { McapTrackingData } from '@/hooks/useMCapTracker'

export type RiskLabel = 'Low' | 'Med' | 'High' | 'Unknown'
export type DataQuality = 'ok' | 'thin'
export type TrackerDecision = 'catch' | 'watch' | 'skip'

export const CATCH_MAX_AGE_MINUTES = 45
export const THIN_SKIP_AGE_MINUTES = 30
export const CATCH_COMBINED_MIN = 0.45
export const CATCH_ML_MIN = 0.55
export const SKIP_COMBINED_MAX = 0.25
export const CATCH_GROWTH_MIN = 80

export type TrackerTokenInsights = {
  riskScore: number | null
  riskLabel: RiskLabel
  dataQuality: DataQuality
  decision: TrackerDecision
  reason: string
  momentumLabel: string
  milestonesReached: number
  milestoneLabels: string[]
  trackingAgeHours: number
  volToMcapPct: number | null
  liquidityLabel: string
  zScoreAvailable: boolean
  zScore: number | null
  timelineInconsistent: boolean
  rugSignal: boolean
}

export type TrackerDecisionScores = {
  combined?: number | null
  mlScore?: number | null
  nowMs?: number
}

export function formatScore0To100(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—/100'
  const clamped = Math.min(100, Math.max(0, Math.round(value)))
  return `${clamped}/100`
}

export function riskLabelFromScore(score: number | null | undefined): RiskLabel {
  if (score == null || !Number.isFinite(score)) return 'Unknown'
  if (score >= 70) return 'High'
  if (score >= 45) return 'Med'
  return 'Low'
}

export function hasUsablePrice(price?: number | null): boolean {
  return price != null && Number.isFinite(price) && price > 0
}

export function hasUsableVolume(volume?: number | null): boolean {
  return volume != null && Number.isFinite(volume)
}

export function resolveTrackerPriceUsd(
  token: McapTrackingData,
  analytics?: EnrichedTokenData,
): number | undefined {
  if (hasUsablePrice(analytics?.current_price_usd)) return analytics!.current_price_usd
  if (hasUsablePrice(token._live_price_usd)) return token._live_price_usd
  return undefined
}

export function isThinMarketData(
  token: McapTrackingData,
  analytics?: EnrichedTokenData,
): boolean {
  const price = resolveTrackerPriceUsd(token, analytics)
  const volume = analytics?.volume_24h
  return !hasUsablePrice(price) && !hasUsableVolume(volume)
}

function categorizeMomentum(growthPercent: number): string {
  if (!Number.isFinite(growthPercent)) return 'unknown'
  if (growthPercent >= 1000) return 'explosive'
  if (growthPercent >= 500) return 'strong'
  if (growthPercent >= 100) return 'moderate'
  if (growthPercent >= 0) return 'weak'
  return 'negative'
}

function deriveMomentumLabel(
  token: McapTrackingData,
  analytics: EnrichedTokenData | undefined,
  dataQuality: DataQuality,
): string {
  if (analytics?.momentum_category) return analytics.momentum_category
  if (analytics?.momentum_signal?.type === 'bullish_breakout') return 'strong'
  if (analytics?.momentum_signal?.type === 'bearish_breakout') return 'negative'
  if (dataQuality === 'thin' || !analytics) return 'unknown'
  return categorizeMomentum(token.mcap_growth_percent || 0)
}

/**
 * Low mcap only adds risk when price or volume is present.
 * Thin price+volume never clamps to 100 from mcap alone.
 */
export function computeRiskScore(
  token: McapTrackingData,
  analytics?: EnrichedTokenData,
): number | null {
  if (isThinMarketData(token, analytics)) return null

  let riskScore = 50
  const mcap = token.current_mcap || 0
  const growth = token.mcap_growth_percent || 0
  const hasPriceOrVol =
    hasUsablePrice(resolveTrackerPriceUsd(token, analytics)) ||
    hasUsableVolume(analytics?.volume_24h)

  if (hasPriceOrVol) {
    if (mcap < 1_000_000) riskScore += 30
    else if (mcap < 10_000_000) riskScore += 20
    else if (mcap < 100_000_000) riskScore += 10
  }

  if (growth < 0) riskScore += 15
  else if (growth >= 200) riskScore += 10

  if (analytics?.z_score_available && typeof analytics.z_score === 'number') {
    if (Math.abs(analytics.z_score) > 2.5) riskScore += 20
  }

  if (token.is_tracking_stuck) riskScore += 15

  return Math.min(100, Math.max(0, riskScore))
}

function liquidityLabelFromVolToMcap(volToMcapPct: number | null): string {
  if (volToMcapPct == null) return 'unknown'
  if (volToMcapPct >= 10) return 'Strong'
  if (volToMcapPct >= 3) return 'Moderate'
  return 'Thin'
}

export function isTrackingTimelineInconsistentClient(token: McapTrackingData): boolean {
  const firstMs = new Date(token.first_seen_at).getTime()
  if (!Number.isFinite(firstMs)) return false
  for (const col of ['when_reach_80pct', 'when_reach_120pct', 'when_reach_200pct'] as const) {
    const v = token[col]
    if (!v) continue
    const m = new Date(v).getTime()
    if (Number.isFinite(m) && firstMs > m) return true
  }
  return false
}

export function formatTrackingAge(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`
  if (hours < 48) return `${hours.toFixed(1)}h`
  return `${Math.round(hours / 24)}d`
}

function isFiniteScore(value?: number | null): value is number {
  return value != null && Number.isFinite(value)
}

function deriveDecision(opts: {
  token: McapTrackingData
  dataQuality: DataQuality
  trackingAgeHours: number
  liquidityLabel: string
  scores?: TrackerDecisionScores
}): { decision: TrackerDecision; reason: string } {
  const { token, dataQuality, trackingAgeHours, liquidityLabel, scores } = opts
  const ageMin = trackingAgeHours * 60
  const hasDrop = Boolean(token.when_drop_40pct || token.when_drop_80pct)
  const combined = scores?.combined
  const mlScore = scores?.mlScore
  const ageLabel = formatTrackingAge(trackingAgeHours)

  if (hasDrop) {
    return {
      decision: 'skip',
      reason: token.when_drop_80pct ? 'dropped −80%' : 'dropped −40%',
    }
  }
  if (dataQuality === 'thin' && ageMin > THIN_SKIP_AGE_MINUTES) {
    return { decision: 'skip', reason: `thin data · age ${ageLabel}` }
  }
  if (isFiniteScore(combined) && combined < SKIP_COMBINED_MAX) {
    return { decision: 'skip', reason: `combined ${combined.toFixed(2)}` }
  }

  const liquidityNotThin = liquidityLabel !== 'Thin' && liquidityLabel !== 'unknown'
  const catchByCombined = isFiniteScore(combined) && combined >= CATCH_COMBINED_MIN
  const catchByMl = isFiniteScore(mlScore) && mlScore >= CATCH_ML_MIN
  const catchByGrowth =
    (token.mcap_growth_percent || 0) >= CATCH_GROWTH_MIN && liquidityNotThin

  if (
    ageMin <= CATCH_MAX_AGE_MINUTES &&
    !hasDrop &&
    (catchByCombined || catchByMl || catchByGrowth)
  ) {
    const parts = [`first_seen ${ageLabel}`]
    if (isFiniteScore(combined)) parts.push(`combined ${combined.toFixed(2)}`)
    else if (isFiniteScore(mlScore)) parts.push(`ml ${mlScore.toFixed(2)}`)
    else parts.push(`growth ${(token.mcap_growth_percent || 0).toFixed(0)}%`)
    return { decision: 'catch', reason: parts.join(' · ') }
  }

  const watchParts = [`first_seen ${ageLabel}`]
  if (isFiniteScore(combined)) watchParts.push(`combined ${combined.toFixed(2)}`)
  return { decision: 'watch', reason: watchParts.join(' · ') }
}

export function formatTrackerDecisionLine(insights: Pick<TrackerTokenInsights, 'decision' | 'reason'>): string {
  return `Decision: ${insights.decision} — ${insights.reason}`
}

export function deriveTrackerTokenInsights(
  token: McapTrackingData,
  analytics?: EnrichedTokenData,
  scores?: TrackerDecisionScores,
): TrackerTokenInsights {
  const growth = token.mcap_growth_percent || 0
  const milestoneLabels: string[] = []
  if (token.when_reach_80pct && growth >= 80) milestoneLabels.push('80%')
  if (token.when_reach_120pct && growth >= 120) milestoneLabels.push('120%')
  if (token.when_reach_200pct && growth >= 200) milestoneLabels.push('200%')
  if (token.when_drop_40pct) milestoneLabels.push('-40%')
  if (token.when_drop_80pct) milestoneLabels.push('-80%')
  if (token.peak_growth_percent != null && token.peak_growth_percent > 0) {
    milestoneLabels.push(`peak +${token.peak_growth_percent.toFixed(0)}%`)
  }
  const nowMs = scores?.nowMs ?? Date.now()
  const firstMs = new Date(token.first_seen_at).getTime()
  const trackingAgeHours = Number.isFinite(firstMs)
    ? Math.max(0, (nowMs - firstMs) / (1000 * 60 * 60))
    : 0

  const vol = analytics?.volume_24h
  const volToMcapPct =
    hasUsableVolume(vol) && token.current_mcap > 0 && (vol as number) > 0
      ? ((vol as number) / token.current_mcap) * 100
      : null

  const dataQuality: DataQuality = isThinMarketData(token, analytics) ? 'thin' : 'ok'
  const riskScore = computeRiskScore(token, analytics)
  const liquidityLabel = liquidityLabelFromVolToMcap(volToMcapPct)
  const rugSignal = Boolean(token.when_drop_40pct || token.when_drop_80pct)
  const { decision, reason } = deriveDecision({
    token,
    dataQuality,
    trackingAgeHours,
    liquidityLabel,
    scores,
  })

  return {
    riskScore,
    riskLabel: riskLabelFromScore(riskScore),
    dataQuality,
    decision,
    reason,
    momentumLabel: deriveMomentumLabel(token, analytics, dataQuality),
    milestonesReached: milestoneLabels.length,
    milestoneLabels,
    trackingAgeHours,
    volToMcapPct,
    liquidityLabel,
    zScoreAvailable: analytics?.z_score_available === true,
    zScore:
      analytics?.z_score_available && typeof analytics.z_score === 'number'
        ? analytics.z_score
        : null,
    timelineInconsistent: isTrackingTimelineInconsistentClient(token),
    rugSignal,
  }
}

export function sortCatchTrainRows<
  T extends { token: McapTrackingData; insights: TrackerTokenInsights },
>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const youngA = a.insights.trackingAgeHours * 60 < CATCH_MAX_AGE_MINUTES ? 0 : 1
    const youngB = b.insights.trackingAgeHours * 60 < CATCH_MAX_AGE_MINUTES ? 0 : 1
    if (youngA !== youngB) return youngA - youngB
    const rank: Record<TrackerDecision, number> = { catch: 0, watch: 1, skip: 2 }
    const ra = rank[a.insights.decision]
    const rb = rank[b.insights.decision]
    if (ra !== rb) return ra - rb
    return (
      new Date(a.token.first_seen_at).getTime() -
      new Date(b.token.first_seen_at).getTime()
    )
  })
}
