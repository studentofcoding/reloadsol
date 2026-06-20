import { STOP_LOSS_THRESHOLD } from '@/utils/mcap-tracker'
import type { SignalsScoringWeights, SignalsStrategyConfig } from './types'

export type SignalScoringItem = {
  token_address: string
  token_symbol: string
  first_mcap: number
  current_mcap: number
  mcap_growth_percent: number
  first_seen_at: string
  last_updated_at: string
  when_reach_80mc?: string | null
  when_reach_120mc?: string | null
  when_reach_200mc?: string | null
  is_tracking_stuck?: boolean
  in_tracking_range: boolean
  trend_age_minutes: number
  time_to_80_minutes?: number | null
}

export type SignalScoreResult = {
  score: number
  decision: 'enter' | 'hold' | 'exit' | 'skip'
  rationale: string
}

export function minutesBetween(aIso?: string | null, bIso?: string | null): number | null {
  if (!aIso || !bIso) return null
  const a = new Date(aIso).getTime()
  const b = new Date(bIso).getTime()
  if (!isFinite(a) || !isFinite(b)) return null
  return Math.round(Math.abs(b - a) / (60 * 1000))
}

export function computeScoreAndDecision(
  item: SignalScoringItem,
  strategyConfig: SignalsStrategyConfig,
): SignalScoreResult {
  const growth = item.mcap_growth_percent || 0
  const isStuck = item.is_tracking_stuck === true
  const nowIso = new Date().toISOString()
  const trendAge = minutesBetween(item.first_seen_at, nowIso) || 0
  const timeTo80 = minutesBetween(item.first_seen_at, item.when_reach_80mc)
  const w = strategyConfig.scoring
  const template = strategyConfig.template
  const enterFloor = strategyConfig.enterScoreFloor
  const minGrowth = strategyConfig.query.minGrowth
  const recencyMinutes = strategyConfig.query.recencyMinutes

  let score = growth

  const recencyBoost =
    Math.max(0, (recencyMinutes - trendAge) / recencyMinutes) * w.recencyBoostMax
  score += recencyBoost

  if (item.when_reach_80mc) score += w.milestone80
  if (item.when_reach_120mc) score += w.milestone120
  if (item.when_reach_200mc) score += w.milestone200

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

  let decision: SignalScoreResult['decision'] = 'skip'
  const rationale: string[] = []

  if (growth <= STOP_LOSS_THRESHOLD || isStuck) {
    decision = 'exit'
    rationale.push('Stop-loss or stuck triggered')
  } else if (template === 'sell_over_100' && growth >= 100) {
    decision = 'exit'
    rationale.push('Growth >100%: late-stage — sell/take profit')
  } else if (growth >= minGrowth && score >= enterFloor) {
    decision = 'enter'
    rationale.push('Strong momentum and recency')
    if (item.when_reach_80mc) rationale.push('Reached +80% threshold')
    if (typeof timeTo80 === 'number') rationale.push(`Reached +80% in ${timeTo80}m`)
  } else if (template === 'sell_over_100' && growth >= 80) {
    decision = 'hold'
    rationale.push('Strong momentum; monitor for exit or take profit')
  } else if (growth >= minGrowth * 0.5) {
    decision = 'hold'
    rationale.push('Moderate momentum, watching for continuation')
  } else {
    decision = 'skip'
    rationale.push('Insufficient momentum')
  }

  return { score, decision, rationale: rationale.join('; ') }
}
