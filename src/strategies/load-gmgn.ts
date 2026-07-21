import { loadStrategyDefinitionRows } from './db'
import { mergeGmgnStrategy } from './merge-gmgn'
import { GMGN_STRATEGIES } from './registry'
import type { GmgnStrategy } from './types'

let cached: Record<string, GmgnStrategy> | null = null
let cacheLoadedAt = 0
const CACHE_TTL_MS = 30_000

export function invalidateGmgnCache(): void {
  cached = null
  cacheLoadedAt = 0
}

export async function getMergedGmgnRegistry(): Promise<Record<string, GmgnStrategy>> {
  const now = Date.now()
  if (cached && now - cacheLoadedAt < CACHE_TTL_MS) {
    return cached
  }

  const rows = await loadStrategyDefinitionRows('gmgn')
  const byId = new Map(rows.map((r) => [r.id, r]))
  const merged: Record<string, GmgnStrategy> = {}

  for (const [id, base] of Object.entries(GMGN_STRATEGIES)) {
    const row = byId.get(id)
    merged[id] = mergeGmgnStrategy(
      base,
      row?.config as import('./types').GmgnStrategyOverride,
      row?.is_active ?? null,
    )
    if (row?.name) merged[id].name = row.name
    if (row?.description) merged[id].description = row.description ?? base.description
    if (row?.execution_mode) merged[id].execution_mode = row.execution_mode
  }

  for (const row of rows) {
    if (merged[row.id]) continue
    if (!row.id.startsWith('search_gmgn_')) continue
    const base = GMGN_STRATEGIES.gmgn_smartmoney_default
    const cloned: GmgnStrategy = {
      ...base,
      id: row.id,
      name: row.name || row.id,
      description: row.description ?? base.description,
      is_active: row.is_active,
      execution_mode: row.execution_mode ?? 'sim_only',
    }
    merged[row.id] = mergeGmgnStrategy(
      cloned,
      row.config as import('./types').GmgnStrategyOverride,
      row.is_active,
    )
  }

  cached = merged
  cacheLoadedAt = now
  return merged
}

export async function getActiveGmgnForSim(): Promise<GmgnStrategy[]> {
  const registry = await getMergedGmgnRegistry()
  return Object.values(registry).filter(
    (s) =>
      s.is_active &&
      s.id !== 'gmgn_roster_concurrence' &&
      s.config.discovery.source !== 'roster' &&
      (s.execution_mode === 'sim_only' || s.execution_mode === 'ab_parallel'),
  )
}

/** Radar Telegram follows GMGN SM/KOL strategy toggles — off when none are active. */
export async function isAnyGmgnRadarStrategyActive(): Promise<boolean> {
  const registry = await getMergedGmgnRegistry()
  return Object.values(registry).some(
    (s) => s.is_active && s.id !== 'gmgn_roster_concurrence',
  )
}

/** Pure helper for tests / callers with a preloaded registry. */
export function hasActiveGmgnRadarStrategy(
  registry: Record<string, Pick<GmgnStrategy, 'is_active'>>,
): boolean {
  return Object.entries(registry).some(
    ([id, s]) => s.is_active && id !== 'gmgn_roster_concurrence',
  )
}
