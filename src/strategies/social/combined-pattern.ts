export const WINNER_MIN_GROWTH_PCT = 120
export const LOSER_MAX_GROWTH_PCT = 80

export type PatternCohort = 'winner' | 'loser' | 'neutral'

export type CombinedInternalExport = {
  tokenAddress: string
  exportedAt: string
  mcapTracker: unknown | null
  socialEvents: unknown | null
}

export function classifyMcapPatternCohort(growthPercent: number | null | undefined): PatternCohort {
  if (growthPercent == null || !Number.isFinite(growthPercent)) return 'neutral'
  if (growthPercent >= WINNER_MIN_GROWTH_PCT) return 'winner'
  if (growthPercent < LOSER_MAX_GROWTH_PCT) return 'loser'
  return 'neutral'
}

export function buildCombinedPattern(params: {
  tokenAddress: string
  exportedAt: string
  mcapRow: unknown | null
  socialEvents: unknown[] | null
}): CombinedInternalExport {
  const events =
    params.socialEvents && params.socialEvents.length > 0 ? params.socialEvents : null
  return {
    tokenAddress: params.tokenAddress,
    exportedAt: params.exportedAt,
    mcapTracker: params.mcapRow,
    socialEvents: events,
  }
}
