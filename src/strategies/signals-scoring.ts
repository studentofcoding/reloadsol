import { STOP_LOSS_THRESHOLD } from '@/utils/mcap-tracker'
import { applySocialBoostToScore } from './social-scoring'
import type { SocialSnapshot } from './social/types'
import type { SignalsScoringWeights, SignalsStrategyConfig } from './types'

export type SignalScoringItem = {
  token_address: string
  token_symbol: string
  first_mcap: number
  current_mcap: number
  mcap_growth_percent: number
  first_seen_at: string
  last_updated_at: string
  when_reach_80pct?: string | null
  when_reach_120pct?: string | null
  when_reach_200pct?: string | null
  when_drop_40pct?: string | null
  when_drop_80pct?: string | null
  peak_mcap?: number | null
  peak_growth_percent?: number | null
  peak_seen_at?: string | null
  label?: string | null
  is_tracking_stuck?: boolean
  in_tracking_range: boolean
  trend_age_minutes: number
  time_to_80_minutes?: number | null
}

export type SignalScoreResult = {
  score: number
  decision: 'enter' | 'hold' | 'exit' | 'skip'
  rationale: string
  socialBoost?: number
  socialNotes?: string[]
}

const MILESTONE_GROWTH_THRESHOLDS = {
  milestone80: 80,
  milestone120: 120,
  milestone200: 200,
} as const

export const DEFAULT_HOLD_GROWTH_FLOOR = 10

export function minutesBetween(aIso?: string | null, bIso?: string | null): number | null {
  if (!aIso || !bIso) return null
  const a = new Date(aIso).getTime()
  const b = new Date(bIso).getTime()
  if (!isFinite(a) || !isFinite(b)) return null
  return Math.round(Math.abs(b - a) / (60 * 1000))
}

/** Time to 80% milestone; null when missing or timeline was clamped to the same instant. */
export function computeTimeTo80Minutes(
  firstSeenAt?: string | null,
  whenReach80?: string | null,
): number | null {
  if (!firstSeenAt || !whenReach80) return null
  const firstMs = new Date(firstSeenAt).getTime()
  const reachMs = new Date(whenReach80).getTime()
  if (!isFinite(firstMs) || !isFinite(reachMs)) return null
  // Skip inflated speed bonus when first_seen_at was clamped to milestone time
  if (Math.abs(reachMs - firstMs) < 60_000) return null
  return Math.round(Math.abs(reachMs - firstMs) / (60 * 1000))
}

export function milestoneBonusEligible(growth: number, threshold: number): boolean {
  return growth >= threshold
}

export function getHoldGrowthFloor(minGrowth: number, holdGrowthFloor?: number): number {
  if (minGrowth > 0) return minGrowth * 0.5
  return holdGrowthFloor ?? DEFAULT_HOLD_GROWTH_FLOOR
}

export function computeScoreAndDecision(
  item: SignalScoringItem,
  strategyConfig: SignalsStrategyConfig,
  socialSnapshot?: SocialSnapshot | null,
): SignalScoreResult {
  const growth = item.mcap_growth_percent || 0
  const isStuck = item.is_tracking_stuck === true
  const nowIso = new Date().toISOString()
  const trendAge = minutesBetween(item.first_seen_at, nowIso) || 0
  const timeTo80 =
    item.time_to_80_minutes ??
    computeTimeTo80Minutes(item.first_seen_at, item.when_reach_80pct)
  const w = strategyConfig.scoring
  const template = strategyConfig.template
  const enterFloor = strategyConfig.enterScoreFloor
  const minGrowth = strategyConfig.query.minGrowth
  const recencyMinutes = strategyConfig.query.recencyMinutes
  const holdFloor = getHoldGrowthFloor(minGrowth, strategyConfig.query.holdGrowthFloor)

  let score = growth

  const recencyBoost =
    Math.max(0, (recencyMinutes - trendAge) / recencyMinutes) * w.recencyBoostMax
  score += recencyBoost

  if (item.when_reach_80pct && milestoneBonusEligible(growth, MILESTONE_GROWTH_THRESHOLDS.milestone80)) {
    score += w.milestone80
  }
  if (item.when_reach_120pct && milestoneBonusEligible(growth, MILESTONE_GROWTH_THRESHOLDS.milestone120)) {
    score += w.milestone120
  }
  if (item.when_reach_200pct && milestoneBonusEligible(growth, MILESTONE_GROWTH_THRESHOLDS.milestone200)) {
    score += w.milestone200
  }

  if (typeof timeTo80 === 'number') {
    if (timeTo80 <= 15) score += w.speedTo80Fast
    else if (timeTo80 <= 30) score += w.speedTo80Medium
    else if (timeTo80 <= 60) score += w.speedTo80Slow
  }

  if (item.in_tracking_range) score += w.inTrackingRange
  if (isStuck) score -= w.stuckPenalty
  if (growth <= STOP_LOSS_THRESHOLD) score -= w.stopLossPenalty

  if (template === 'sell_over_100' && growth >= 100) {
    score -= w.sellOver100LatePenalty
  }

  let socialBoost = 0
  let socialNotes: string[] = []
  if (socialSnapshot) {
    const socialResult = applySocialBoostToScore(score, socialSnapshot, {
      mentionTier1: w.socialMentionTier1,
      mentionTier2: w.socialMentionTier2,
      mentionTier3: w.socialMentionTier3,
      uniqueChannelBonus: w.socialUniqueChannelBonus,
      smartWalletBuyBonus: w.socialSmartWalletBuyBonus,
      tier1WalletBonus: w.socialTier1WalletBonus,
    })
    score = socialResult.score
    socialBoost = socialResult.socialBoost
    socialNotes = socialResult.socialNotes
  }

  let decision: SignalScoreResult['decision'] = 'skip'
  const rationale: string[] = []

  const reached80Now = !!item.when_reach_80pct && milestoneBonusEligible(growth, MILESTONE_GROWTH_THRESHOLDS.milestone80)
  const hitRugDrop = !!item.when_drop_40pct || growth <= -40

  if (hitRugDrop) {
    decision = 'exit'
    rationale.push(
      item.when_drop_80pct || growth <= -80
        ? 'Rug drop ≤-80% — exit'
        : 'Rug drop ≤-40% — exit',
    )
  } else if (growth <= STOP_LOSS_THRESHOLD || isStuck) {
    decision = 'exit'
    rationale.push('Stop-loss or stuck triggered')
  } else if (template === 'sell_over_100' && growth >= 100) {
    decision = 'exit'
    rationale.push('Growth >100%: late-stage — sell/take profit')
  } else if (growth >= minGrowth && score >= enterFloor) {
    decision = 'enter'
    rationale.push('Strong momentum and recency')
    if (reached80Now) rationale.push('Reached +80% threshold')
    if (typeof timeTo80 === 'number') rationale.push(`Reached +80% in ${timeTo80}m`)
  } else if (template === 'sell_over_100' && growth >= 80) {
    decision = 'hold'
    rationale.push('Strong momentum; monitor for exit or take profit')
  } else if (growth >= holdFloor) {
    decision = 'hold'
    rationale.push('Moderate momentum, watching for continuation')
  } else {
    decision = 'skip'
    rationale.push('Insufficient momentum')
  }

  return {
    score,
    decision,
    rationale: rationale.join('; '),
    socialBoost,
    socialNotes,
  }
}

export function buildSignalScoringItem(input: {
  token_address: string
  token_symbol: string
  first_mcap: number
  current_mcap: number
  mcap_growth_percent: number
  first_seen_at: string
  last_updated_at: string
  when_reach_80pct?: string | null
  when_reach_120pct?: string | null
  when_reach_200pct?: string | null
  when_drop_40pct?: string | null
  when_drop_80pct?: string | null
  peak_mcap?: number | null
  peak_growth_percent?: number | null
  peak_seen_at?: string | null
  label?: string | null
  is_tracking_stuck?: boolean
  in_tracking_range: boolean
}): SignalScoringItem {
  const nowIso = new Date().toISOString()
  return {
    ...input,
    trend_age_minutes: minutesBetween(input.first_seen_at, nowIso) || 0,
    time_to_80_minutes: computeTimeTo80Minutes(input.first_seen_at, input.when_reach_80pct),
  }
}

export function applyScoreToItem(
  item: SignalScoringItem,
  strategyConfig: SignalsStrategyConfig,
  socialSnapshot?: SocialSnapshot | null,
): SignalScoringItem & SignalScoreResult {
  return { ...item, ...computeScoreAndDecision(item, strategyConfig, socialSnapshot) }
}
