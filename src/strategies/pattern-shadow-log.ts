import type { PatternMlShadowScore } from './entry-pattern-scorer'

export function mergePatternShadowIntoEntryFeatures(
  entryFeatures: Record<string, unknown>,
  shadow: PatternMlShadowScore | null,
): Record<string, unknown> {
  if (!shadow?.pattern) return entryFeatures

  return {
    ...entryFeatures,
    ml_pattern_scored_at: shadow.scoredAt,
    ml_pattern_model_version: shadow.modelVersion ?? null,
    ml_pattern_p_winner: shadow.pattern.pWinner,
    ml_pattern_p_loser: shadow.pattern.pLoser,
    ml_pattern_predicted: shadow.pattern.predicted,
  }
}

export function logPatternGateCounterfactual(input: {
  mintAddress: string
  strategyId: string
  pWinner: number
  threshold: number
  reason: string
}): void {
  console.info('[ml-pattern:counterfactual]', {
    mint: input.mintAddress,
    strategy: input.strategyId,
    p_winner: input.pWinner,
    threshold: input.threshold,
    reason: input.reason,
    at: new Date().toISOString(),
  })
}
