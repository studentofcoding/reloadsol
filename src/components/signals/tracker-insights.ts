import type { EnrichedTokenData } from '@/utils/data-aggregation'
import type { McapTrackingData } from '@/hooks/useMCapTracker'

export type RiskLabel = 'Low' | 'Med' | 'High'

export type TrackerTokenInsights = {
  riskScore: number
  riskLabel: RiskLabel
  momentumLabel: string
  milestonesReached: number
  milestoneLabels: string[]
  trackingAgeHours: number
  volToMcapPct: number | null
  liquidityLabel: string
  zScoreAvailable: boolean
  zScore: number | null
  timelineInconsistent: boolean
}

export function formatScore0To100(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const clamped = Math.min(100, Math.max(0, Math.round(value)))
  return `${clamped}/100`
}

export function riskLabelFromScore(score: number): RiskLabel {
  if (score >= 70) return 'High'
  if (score >= 45) return 'Med'
  return 'Low'
}

function categorizeMomentum(growthPercent: number): string {
  if (!Number.isFinite(growthPercent)) return 'weak'
  if (growthPercent >= 1000) return 'explosive'
  if (growthPercent >= 500) return 'strong'
  if (growthPercent >= 100) return 'moderate'
  if (growthPercent >= 0) return 'weak'
  return 'negative'
}

function computeRiskScore(token: McapTrackingData, analytics?: EnrichedTokenData): number {
  let riskScore = 50
  const mcap = token.current_mcap || 0
  const growth = token.mcap_growth_percent || 0

  if (mcap < 1_000_000) riskScore += 30
  else if (mcap < 10_000_000) riskScore += 20
  else if (mcap < 100_000_000) riskScore += 10

  if (growth < 0) riskScore += 15
  else if (growth >= 200) riskScore += 10

  if (analytics?.z_score_available && typeof analytics.z_score === 'number') {
    if (Math.abs(analytics.z_score) > 2.5) riskScore += 20
  }

  if (token.is_tracking_stuck) riskScore += 15

  return Math.min(100, Math.max(0, riskScore))
}

function liquidityLabelFromVolToMcap(volToMcapPct: number | null): string {
  if (volToMcapPct == null) return 'No volume data'
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

export function deriveTrackerTokenInsights(
  token: McapTrackingData,
  analytics?: EnrichedTokenData,
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
  const firstMs = new Date(token.first_seen_at).getTime()
  const trackingAgeHours = Number.isFinite(firstMs)
    ? Math.max(0, (Date.now() - firstMs) / (1000 * 60 * 60))
    : 0

  const vol = analytics?.volume_24h
  const volToMcapPct =
    vol && token.current_mcap > 0 ? (vol / token.current_mcap) * 100 : null

  const riskScore = computeRiskScore(token, analytics)

  return {
    riskScore,
    riskLabel: riskLabelFromScore(riskScore),
    momentumLabel: analytics?.momentum_category ?? categorizeMomentum(growth),
    milestonesReached: milestoneLabels.length,
    milestoneLabels,
    trackingAgeHours,
    volToMcapPct,
    liquidityLabel: liquidityLabelFromVolToMcap(volToMcapPct),
    zScoreAvailable: analytics?.z_score_available === true,
    zScore:
      analytics?.z_score_available && typeof analytics.z_score === 'number'
        ? analytics.z_score
        : null,
    timelineInconsistent: isTrackingTimelineInconsistentClient(token),
  }
}

export function formatTrackingAge(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`
  if (hours < 48) return `${hours.toFixed(1)}h`
  return `${Math.round(hours / 24)}d`
}
