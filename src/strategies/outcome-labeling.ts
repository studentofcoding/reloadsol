import type { OutcomeMlCondition, OutcomeMlLabel } from './types'

export type TrainingClass = 0 | 1 | null

const WIN_PNL_THRESHOLD = 50
const LOSE_PNL_THRESHOLD = 20

export function computeTrainingClass(
  pnlPct: number | null | undefined,
  status: string | null | undefined,
): TrainingClass {
  if (pnlPct == null || !Number.isFinite(pnlPct)) return null
  const isWon = status === 'won' || pnlPct >= 0
  if (isWon && pnlPct >= WIN_PNL_THRESHOLD) return 1
  if (!isWon || pnlPct < LOSE_PNL_THRESHOLD) return 0
  return null
}

export function trainingClassToMlLabel(
  trainingClass: TrainingClass,
): OutcomeMlLabel | null {
  if (trainingClass === 1) return 'interesting'
  if (trainingClass === 0) return 'skip'
  return null
}

export function inferMlCondition(
  features: Record<string, unknown>,
): OutcomeMlCondition | null {
  const age = features.token_age_hours
  if (typeof age === 'number') {
    if (age < 2) return 'new_chart'
    if (age > 24) return 'old_chart'
  }
  const closeReason = features.close_reason
  const growth = features.mcap_growth_at_exit
  if (
    closeReason === 'take_profit_200' ||
    (typeof growth === 'number' && growth >= 100)
  ) {
    return 'price_topped'
  }
  return null
}

export function buildAutoMlNote(
  features: Record<string, unknown>,
  pnlPct: number | null | undefined,
  trainingClass: TrainingClass,
): string {
  const parts: string[] = ['auto']
  if (pnlPct != null && Number.isFinite(pnlPct)) {
    parts.push(`${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`)
  }
  if (trainingClass === 1) parts.push('class=1')
  if (trainingClass === 0) parts.push('class=0')
  if (trainingClass === null) parts.push('marginal')
  if (features.reached_80 === true) parts.push('reached_80')
  if (typeof features.organic_score === 'number') {
    parts.push(`organic=${features.organic_score}`)
  }
  return parts.join(': ')
}

/** Apply auto ML fields when not manually labeled. */
export function applyAutoOutcomeLabels(
  features: Record<string, unknown> | null | undefined,
  pnlPct: number | null | undefined,
  status: string | null | undefined,
): Record<string, unknown> {
  const base = { ...(features ?? {}) }
  if (base.ml_manual === true) return base

  const trainingClass = computeTrainingClass(pnlPct, status)
  const mlLabel = trainingClassToMlLabel(trainingClass)
  const mlCondition = inferMlCondition(base)
  const mlNote = buildAutoMlNote(base, pnlPct, trainingClass)

  return {
    ...base,
    training_class: trainingClass,
    ...(mlLabel ? { ml_label: mlLabel } : {}),
    ...(mlCondition ? { ml_condition: mlCondition } : {}),
    ml_note: mlNote,
  }
}
