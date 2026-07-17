import { loadStrategyDefinitionRows } from './db'
import { mergeSocialStrategy } from './merge-social'
import { SOCIAL_STRATEGIES } from './registry'
import type { SocialStrategy } from './types'

let cached: Record<string, SocialStrategy> | null = null
let cacheLoadedAt = 0
const CACHE_TTL_MS = 30_000

export function invalidateSocialCache(): void {
  cached = null
  cacheLoadedAt = 0
}

export async function getMergedSocialRegistry(): Promise<Record<string, SocialStrategy>> {
  const now = Date.now()
  if (cached && now - cacheLoadedAt < CACHE_TTL_MS) {
    return cached
  }

  const rows = await loadStrategyDefinitionRows('social')
  const byId = new Map(rows.map((r) => [r.id, r]))
  const merged: Record<string, SocialStrategy> = {}

  for (const [id, base] of Object.entries(SOCIAL_STRATEGIES)) {
    const row = byId.get(id)
    merged[id] = mergeSocialStrategy(
      base,
      row?.config as import('./types').SocialStrategyOverride,
      row?.is_active ?? null,
    )
    if (row?.name) merged[id].name = row.name
    if (row?.description) merged[id].description = row.description ?? base.description
    if (row?.execution_mode) merged[id].execution_mode = row.execution_mode
  }

  cached = merged
  cacheLoadedAt = now
  return merged
}

export async function getActiveSocialForSim(): Promise<SocialStrategy[]> {
  const registry = await getMergedSocialRegistry()
  return Object.values(registry).filter(
    (s) =>
      s.is_active &&
      (s.execution_mode === 'sim_only' || s.execution_mode === 'ab_parallel'),
  )
}
