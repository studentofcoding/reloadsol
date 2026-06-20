import { loadStrategyDefinitionRows } from './db'
import { mergeSignalsStrategy } from './merge-signals'
import { SIGNALS_STRATEGIES } from './registry'
import type { ExecutionMode, SignalsStrategy } from './types'

let cached: Record<string, SignalsStrategy> | null = null
let cacheLoadedAt = 0
const CACHE_TTL_MS = 30_000

export function invalidateSignalsCache(): void {
  cached = null
  cacheLoadedAt = 0
}

export async function getMergedSignalsRegistry(): Promise<Record<string, SignalsStrategy>> {
  const now = Date.now()
  if (cached && now - cacheLoadedAt < CACHE_TTL_MS) {
    return cached
  }

  const rows = await loadStrategyDefinitionRows('signals')
  const byId = new Map(rows.map((r) => [r.id, r]))
  const merged: Record<string, SignalsStrategy> = {}

  for (const [id, base] of Object.entries(SIGNALS_STRATEGIES)) {
    const row = byId.get(id)
    merged[id] = mergeSignalsStrategy(
      base,
      row?.config as import('./types').SignalsStrategyOverride,
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

export async function getActiveSignalsForSim(): Promise<SignalsStrategy[]> {
  const registry = await getMergedSignalsRegistry()
  return Object.values(registry).filter(
    (s) =>
      s.is_active &&
      (s.execution_mode === 'sim_only' || s.execution_mode === 'ab_parallel'),
  )
}

export async function getSignalsStrategy(id: string): Promise<SignalsStrategy | null> {
  const registry = await getMergedSignalsRegistry()
  return registry[id] ?? null
}

export function resolveExecutionMode(
  rowMode: ExecutionMode | undefined,
  fallback: ExecutionMode,
): ExecutionMode {
  return rowMode ?? fallback
}
