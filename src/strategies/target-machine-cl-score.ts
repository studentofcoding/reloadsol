/**
 * Fail-soft closed-loop mlScore for Target machine paper opens.
 * Reuses loadCombinedScore (same stack as Early Enter / ML score API).
 */
import { isMlClosedLoopEnabled } from '@/strategies/closed-loop-ml'
import { loadCombinedScore } from '@/strategies/combined-score-load'
import type { CombinedScoreChain } from '@/strategies/combined-score'

export async function loadTargetMachineClScore(params: {
  mint: string
  chain: CombinedScoreChain
  entryMcap?: number | null
}): Promise<{ mlScore: number | null; modelVersion: string | null }> {
  try {
    if (!isMlClosedLoopEnabled()) {
      return { mlScore: null, modelVersion: null }
    }
    const score = await loadCombinedScore({
      address: params.mint,
      chain: params.chain,
      hours: 24,
      entryMcap: params.entryMcap,
    })
    return {
      mlScore: score.mlScore ?? null,
      modelVersion: score.modelVersion ?? null,
    }
  } catch {
    return { mlScore: null, modelVersion: null }
  }
}
