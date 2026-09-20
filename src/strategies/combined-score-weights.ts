/**
 * Persist combined-score weights in strategy_definitions (same pattern as
 * ml2_exit_overlay). Operators edit from /dev/strategies; score reads live.
 *
 * ponytail: invalid / missing row → v1 defaults so Freeview never blanks.
 */
import {
  COMBINED_SCORE_WEIGHTS,
  validateCombinedScoreWeights,
  type CombinedScoreWeights,
} from '@/strategies/combined-score'

export const COMBINED_SCORE_WEIGHTS_STRATEGY_ID = 'combined_score'

const CACHE_TTL_MS = 30_000

let cached: CombinedScoreWeights | null = null
let cacheLoadedAt = 0
let cacheSource: 'stored' | 'defaults' = 'defaults'

export function invalidateCombinedScoreWeightsCache(): void {
  cached = null
  cacheLoadedAt = 0
  cacheSource = 'defaults'
}

export function peekCombinedScoreWeightsCache(): {
  weights: CombinedScoreWeights
  source: 'stored' | 'defaults'
} | null {
  if (!cached) return null
  return { weights: cached, source: cacheSource }
}

export async function loadCombinedScoreWeights(): Promise<{
  weights: CombinedScoreWeights
  source: 'stored' | 'defaults'
}> {
  const now = Date.now()
  if (cached && now - cacheLoadedAt < CACHE_TTL_MS) {
    return { weights: cached, source: cacheSource }
  }

  try {
    const { loadStrategyDefinitionById } = await import('./db')
    const row = await loadStrategyDefinitionById(COMBINED_SCORE_WEIGHTS_STRATEGY_ID)
    const validated = validateCombinedScoreWeights(row?.config)
    if (validated.ok) {
      cached = validated.weights
      cacheSource = 'stored'
      cacheLoadedAt = now
      return { weights: cached, source: cacheSource }
    }
  } catch {
    /* fall through to defaults */
  }

  cached = { ...COMBINED_SCORE_WEIGHTS }
  cacheSource = 'defaults'
  cacheLoadedAt = now
  return { weights: cached, source: cacheSource }
}

export async function saveCombinedScoreWeights(
  raw: unknown,
): Promise<
  | { ok: true; weights: CombinedScoreWeights; renormalized: boolean; sumBefore: number }
  | { ok: false; error: string }
> {
  const validated = validateCombinedScoreWeights(raw)
  if (!validated.ok) return validated

  const { upsertStrategyDefinition } = await import('./db')
  const result = await upsertStrategyDefinition({
    id: COMBINED_SCORE_WEIGHTS_STRATEGY_ID,
    domain: 'mcap_tracker',
    name: 'Combined score weights',
    description:
      'Principal + adjuster combined-score weights (Freeview). Saved values are renormalized to sum 1.',
    config: validated.weights as unknown as Record<string, unknown>,
    is_active: true,
    execution_mode: 'sim_only',
  })
  if (!result.ok) {
    return { ok: false, error: result.error ?? 'save failed' }
  }

  cached = validated.weights
  cacheSource = 'stored'
  cacheLoadedAt = Date.now()
  return {
    ok: true,
    weights: validated.weights,
    renormalized: validated.renormalized,
    sumBefore: validated.sumBefore,
  }
}

export async function resetCombinedScoreWeights(): Promise<
  | { ok: true; weights: CombinedScoreWeights; renormalized: boolean; sumBefore: number }
  | { ok: false; error: string }
> {
  return saveCombinedScoreWeights({ ...COMBINED_SCORE_WEIGHTS })
}
