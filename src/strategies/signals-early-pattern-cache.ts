import {
  scorePredictivePattern,
  type PredictivePatternScore,
} from '@/strategies/social/predictive-pattern-alert'
import type { McapSnapshot } from '@/utils/mcap-tracker'

const CACHE_TTL_MS = 5 * 60 * 1000
const MAX_CACHE = 200

type CacheEntry = {
  score: PredictivePatternScore
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

function pruneCache(now: number): void {
  const keysToDelete: string[] = []
  cache.forEach((entry, key) => {
    if (entry.expiresAt <= now) keysToDelete.push(key)
  })
  keysToDelete.forEach((key) => cache.delete(key))
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value
    if (oldest == null) break
    cache.delete(oldest)
  }
}

export function formatPatternShadowLabel(score: {
  pWinner?: number | null
  predicted?: 'winner' | 'loser' | null
}): string {
  if (score.pWinner == null || !Number.isFinite(score.pWinner)) {
    return 'n/a'
  }
  const pred = score.predicted ?? '—'
  return `pW ${score.pWinner.toFixed(2)} → ${pred}`
}

/** Cached Pattern ML shadow score for Stage-1 (5 min TTL per mint). */
export async function getCachedStage1PatternScore(
  tokenAddress: string,
  snapshot?: McapSnapshot | null,
): Promise<PredictivePatternScore> {
  const now = Date.now()
  pruneCache(now)

  const hit = cache.get(tokenAddress)
  if (hit && hit.expiresAt > now) {
    return hit.score
  }

  const score = await scorePredictivePattern(tokenAddress, snapshot)
  cache.set(tokenAddress, { score, expiresAt: now + CACHE_TTL_MS })
  return score
}

/** Score up to `concurrency` mints in parallel (for Signals table enrichment). */
export async function scoreStage1PatternBatch(
  tokenAddresses: string[],
  concurrency = 5,
): Promise<Map<string, PredictivePatternScore>> {
  const result = new Map<string, PredictivePatternScore>()
  const unique = Array.from(new Set(tokenAddresses.filter(Boolean)))
  for (let i = 0; i < unique.length; i += concurrency) {
    const batch = unique.slice(i, i + concurrency)
    const scores = await Promise.all(
      batch.map(async (addr) => {
        const score = await getCachedStage1PatternScore(addr)
        return [addr, score] as const
      }),
    )
    for (const [addr, score] of scores) {
      result.set(addr, score)
    }
  }
  return result
}

/** Test helper */
export function resetStage1PatternCacheForTests(): void {
  cache.clear()
}
