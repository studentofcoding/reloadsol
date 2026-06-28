import type { EntryMlShadowScore } from './entry-ml-scorer'

export function mergeShadowScoresIntoEntryFeatures(
  entryFeatures: Record<string, unknown>,
  shadow: EntryMlShadowScore | null,
): Record<string, unknown> {
  if (!shadow) return entryFeatures

  const next: Record<string, unknown> = {
    ...entryFeatures,
    ml_shadow_at: shadow.scoredAt,
  }

  if (shadow.modelVersions.gate) {
    next.ml_gate_model_version = shadow.modelVersions.gate
  }
  if (shadow.modelVersions.potential) {
    next.ml_potential_model_version = shadow.modelVersions.potential
  }

  if (shadow.gate) {
    next.ml_gate_p_bad = shadow.gate.pBad
    next.ml_gate_p_good = shadow.gate.pGood
    next.ml_gate_predicted = shadow.gate.predicted
  }

  if (shadow.potential) {
    next.ml_potential_tier = shadow.potential.tier
    next.ml_potential_moon_score = shadow.potential.moonScore
    next.ml_potential_probs = shadow.potential.probs
  }

  return next
}
