import { loadStrategyDefinitionRows } from './db'
import { mergeMcapTrackerStrategy } from './merge-mcap-tracker'
import { MCAP_TRACKER_STRATEGIES } from './registry'
import type { McapTrackerStrategy } from './types'

let cached: Record<string, McapTrackerStrategy> | null = null
let cacheLoadedAt = 0
const CACHE_TTL_MS = 30_000

export function invalidateMcapTrackerCache(): void {
  cached = null
  cacheLoadedAt = 0
}

export async function getMergedMcapTrackerRegistry(): Promise<Record<string, McapTrackerStrategy>> {
  const now = Date.now()
  if (cached && now - cacheLoadedAt < CACHE_TTL_MS) {
    return cached
  }

  const rows = await loadStrategyDefinitionRows('mcap_tracker')
  const byId = new Map(rows.map((r) => [r.id, r]))
  const merged: Record<string, McapTrackerStrategy> = {}

  for (const [id, base] of Object.entries(MCAP_TRACKER_STRATEGIES)) {
    const row = byId.get(id)
    merged[id] = mergeMcapTrackerStrategy(
      base,
      row?.config as import('./types').McapTrackerStrategyOverride,
      row?.is_active ?? null,
    )
    if (row?.name) merged[id].name = row.name
    if (row?.description) merged[id].description = row.description ?? base.description
    if (row?.execution_mode) merged[id].execution_mode = row.execution_mode
  }

  // DB-only search experiments (P2 bandit)
  for (const row of rows) {
    if (merged[row.id]) continue
    if (!row.id.startsWith('search_mcap_')) continue
    const cfg = (row.config ?? {}) as import('./types').McapTrackerStrategyOverride & {
      entryTemplate?: 'first_seen' | 'milestone_80'
    }
    const template = cfg.entryTemplate ?? 'first_seen'
    const base =
      template === 'milestone_80'
        ? MCAP_TRACKER_STRATEGIES.mcap_enter_at_80
        : MCAP_TRACKER_STRATEGIES.mcap_enter_first_seen
    const cloned: McapTrackerStrategy = {
      ...base,
      id: row.id,
      name: row.name || row.id,
      description: row.description ?? base.description,
      is_active: row.is_active,
      execution_mode: row.execution_mode ?? 'sim_only',
    }
    merged[row.id] = mergeMcapTrackerStrategy(cloned, cfg, row.is_active)
  }

  cached = merged
  cacheLoadedAt = now
  return merged
}

export async function getActiveMcapTrackerStrategies(): Promise<McapTrackerStrategy[]> {
  const registry = await getMergedMcapTrackerRegistry()
  return Object.values(registry).filter(
    (s) =>
      s.is_active &&
      (s.execution_mode === 'sim_only' ||
        s.execution_mode === 'ab_parallel' ||
        s.execution_mode === 'live_only'),
  )
}

/** @deprecated use getActiveMcapTrackerStrategies */
export async function getActiveMcapTrackerForSim(): Promise<McapTrackerStrategy[]> {
  return getActiveMcapTrackerStrategies()
}
