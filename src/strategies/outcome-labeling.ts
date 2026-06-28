import type { OutcomeMlCondition, OutcomeMlLabel, TrainingClass } from './types'

export type { TrainingClass }

export function computeTrainingClass(
  pnlPct: number | null | undefined,
  status: string | null | undefined,
): TrainingClass {
  if (pnlPct == null || !Number.isFinite(pnlPct)) return null
  const isWon = status === 'won' || pnlPct >= 0

  if (!isWon || pnlPct < 0) return 0
  if (isWon && pnlPct < 20) return 0
  if (isWon && pnlPct < 50) return 1
  if (pnlPct < 100) return 2
  if (pnlPct < 300) return 3
  return 4
}

export function trainingClassToMlLabel(
  trainingClass: TrainingClass,
): OutcomeMlLabel | null {
  if (trainingClass === 0) return 'skip'
  if (trainingClass != null && trainingClass >= 1 && trainingClass <= 4) {
    return 'interesting'
  }
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
  if (trainingClass != null) parts.push(`class=${trainingClass}`)
  if (features.reached_80 === true) parts.push('reached_80')
  if (typeof features.organic_score === 'number') {
    parts.push(`organic=${features.organic_score}`)
  }
  return parts.join(': ')
}

/** Apply manual training class override; syncs ml_label and marks ml_manual. */
export function applyManualTrainingClass(
  features: Record<string, unknown>,
  trainingClass: 0 | 1 | 2 | 3 | 4,
): Record<string, unknown> {
  const mlLabel = trainingClassToMlLabel(trainingClass)
  return {
    ...features,
    ml_manual: true,
    training_class: trainingClass,
    ...(mlLabel ? { ml_label: mlLabel } : {}),
  }
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
    ...(trainingClass != null ? { training_class: trainingClass } : {}),
    ...(mlLabel ? { ml_label: mlLabel } : {}),
    ...(mlCondition ? { ml_condition: mlCondition } : {}),
    ml_note: mlNote,
  }
}
