import { loadStrategyDefinitionRows } from './db'
import { mergeSignalsStrategy } from './merge-signals'
import { SIGNALS_STRATEGIES } from './registry'
import type { SignalsStrategy, StrategyChain } from './types'

const cachedByChain = new Map<
  StrategyChain,
  { registry: Record<string, SignalsStrategy>; loadedAt: number }
>()
const CACHE_TTL_MS = 30_000

export function invalidateSignalsCache(): void {
  cachedByChain.clear()
}

export async function getMergedSignalsRegistry(
  chain: StrategyChain = 'sol',
): Promise<Record<string, SignalsStrategy>> {
  const now = Date.now()
  const cached = cachedByChain.get(chain)
  if (cached && now - cached.loadedAt < CACHE_TTL_MS) {
    return cached.registry
  }

  const rows = await loadStrategyDefinitionRows('signals', chain)
  const byId = new Map(rows.map((r) => [r.id, r]))
  const merged: Record<string, SignalsStrategy> = {}

  for (const [id, base] of Object.entries(SIGNALS_STRATEGIES)) {
    if ((base.chain ?? 'sol') !== chain) continue
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

  for (const row of rows) {
    if (merged[row.id]) continue
    if (!row.id.startsWith('search_signals_')) continue
    const base = SIGNALS_STRATEGIES.signals_default
    const cloned: SignalsStrategy = {
      ...base,
      id: row.id,
      name: row.name || row.id,
      description: row.description ?? base.description,
      is_active: row.is_active,
      execution_mode: row.execution_mode ?? 'sim_only',
    }
    merged[row.id] = mergeSignalsStrategy(
      cloned,
      row.config as import('./types').SignalsStrategyOverride,
      row.is_active,
    )
  }

  cachedByChain.set(chain, { registry: merged, loadedAt: now })
  return merged
}

export async function getActiveSignalsForSim(
  chain: StrategyChain = 'sol',
): Promise<SignalsStrategy[]> {
  const registry = await getMergedSignalsRegistry(chain)
  return Object.values(registry).filter(
    (s) =>
      s.is_active &&
      (s.execution_mode === 'sim_only' || s.execution_mode === 'ab_parallel'),
  )
}

export async function getSignalsStrategy(
  id: string,
  chain: StrategyChain = 'sol',
): Promise<SignalsStrategy | null> {
  const registry = await getMergedSignalsRegistry(chain)
  return registry[id] ?? null
}
