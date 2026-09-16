/**
 * Opt-in mcap sim-track universe from market-brain GET /union (membership).
 *
 * Default path stays token_mcap_tracking candidates. Enable with:
 *   MARKET_BRAIN_MCAP=1
 *   MARKET_BRAIN_TOKEN=<BRAIN_READ_TOKEN>
 *
 * When enabled, sim opens are intersected with /union mints and default recipe
 * gates (membership, mcap≥50k, liq≥10k, climateSafe). Brain fetch failures fail
 * soft and keep the tracker list. Live execute is unchanged.
 */

import type { GateEvalResult } from '@/utils/brain-gates'
import {
  evaluateUniverseOpen,
  filterByMintMembership,
  loadBrainUnionUniverse,
  type BrainUnionUniverse,
} from '@/utils/brain-union-universe'
import {
  isMarketBrainMcapEnabled,
  marketBrainMcapSkipReason,
  type MarketBrainFetchOpts,
} from '@/utils/market-brain'

export type McapBrainItem = {
  token_address: string
  current_mcap?: number | null
  first_mcap?: number | null
}

export type BrainMcapUniverseResult<T> = {
  items: T[]
  applied: boolean
  source: BrainUnionUniverse['source']
  kept: number
  total: number
  unionSize: number
  universe: BrainUnionUniverse
  error?: string
}

export function mcapItemMint(item: McapBrainItem | null | undefined): string | null {
  const id = item?.token_address
  if (typeof id !== 'string') return null
  const trimmed = id.trim()
  return trimmed ? trimmed : null
}

export function filterMcapByUnionMembership<T extends McapBrainItem>(
  items: T[],
  unionMints: Iterable<string>,
): T[] {
  return filterByMintMembership(items, mcapItemMint, unionMints)
}

/**
 * If MARKET_BRAIN_MCAP=1 and a token is configured, keep only tracker rows
 * whose mint is on brain `/union` (or the matching recipe universe).
 * Otherwise return items unchanged.
 */
export async function applyBrainMcapUniverse<T extends McapBrainItem>(
  items: T[],
  opts: MarketBrainFetchOpts & { recipeId?: string } = {},
): Promise<BrainMcapUniverseResult<T>> {
  const total = items.length
  const loaded = await loadBrainUnionUniverse({
    ...opts,
    enabled: isMarketBrainMcapEnabled(opts),
    skipReason: marketBrainMcapSkipReason(opts),
    recipeId: opts.recipeId,
    domain: 'mcap',
  })
  if (!loaded.applied) {
    return {
      items,
      applied: false,
      source: 'local',
      kept: total,
      total,
      unionSize: 0,
      universe: loaded,
      error: loaded.error,
    }
  }

  const filtered = filterMcapByUnionMembership(items, loaded.mints)
  return {
    items: filtered,
    applied: true,
    source: loaded.source,
    kept: filtered.length,
    total,
    unionSize: loaded.unionSize,
    universe: loaded,
  }
}

export function evaluateMcapBrainOpen<T extends McapBrainItem>(
  snapshot: T,
  universe: BrainMcapUniverseResult<unknown> | BrainUnionUniverse,
  opts: {
    climate?: Parameters<typeof evaluateUniverseOpen>[2]['climate']
    recipeId?: string
  } = {},
): GateEvalResult {
  const loaded = 'items' in universe ? universe.universe : universe
  return evaluateUniverseOpen(snapshot, loaded, {
    climate: opts.climate,
    recipeId: opts.recipeId,
    domain: 'mcap',
  })
}
