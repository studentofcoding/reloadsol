/**
 * Opt-in signals sim-track universe from market-brain GET /union (membership).
 *
 * Default path stays scored token_mcap_tracking candidates. Enable with:
 *   MARKET_BRAIN_SIGNALS=1
 *   MARKET_BRAIN_TOKEN=<BRAIN_READ_TOKEN>
 *
 * When enabled, enter candidates are intersected with /union mints (prefer
 * seeded `signals_sell_over_100` / signals-domain recipe universe) and default
 * recipe gates. Brain fetch failures fail soft and keep the scored list.
 */

import type { GateEvalResult } from '@/utils/brain-gates'
import {
  evaluateUniverseOpen,
  filterByMintMembership,
  loadBrainUnionUniverse,
  type BrainUnionUniverse,
} from '@/utils/brain-union-universe'
import {
  isMarketBrainSignalsEnabled,
  marketBrainSignalsSkipReason,
  type MarketBrainFetchOpts,
} from '@/utils/market-brain'

export type SignalsBrainItem = {
  token_address: string
  current_mcap?: number | null
  first_mcap?: number | null
}

export type BrainSignalsUniverseResult<T> = {
  items: T[]
  applied: boolean
  source: BrainUnionUniverse['source']
  kept: number
  total: number
  unionSize: number
  universe: BrainUnionUniverse
  error?: string
}

export function signalsItemMint(item: SignalsBrainItem | null | undefined): string | null {
  const id = item?.token_address
  if (typeof id !== 'string') return null
  const trimmed = id.trim()
  return trimmed ? trimmed : null
}

export function filterSignalsByUnionMembership<T extends SignalsBrainItem>(
  items: T[],
  unionMints: Iterable<string>,
): T[] {
  return filterByMintMembership(items, signalsItemMint, unionMints)
}

/**
 * If MARKET_BRAIN_SIGNALS=1 and a token is configured, keep only scored rows
 * whose mint is on brain `/union` (or the matching signals recipe universe).
 * Otherwise return items unchanged.
 */
export async function applyBrainSignalsUniverse<T extends SignalsBrainItem>(
  items: T[],
  opts: MarketBrainFetchOpts & { recipeId?: string } = {},
): Promise<BrainSignalsUniverseResult<T>> {
  const total = items.length
  const loaded = await loadBrainUnionUniverse({
    ...opts,
    enabled: isMarketBrainSignalsEnabled(opts),
    skipReason: marketBrainSignalsSkipReason(opts),
    recipeId: opts.recipeId ?? 'signals_sell_over_100',
    domain: 'signals',
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

  const filtered = filterSignalsByUnionMembership(items, loaded.mints)
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

export function evaluateSignalsBrainOpen<T extends SignalsBrainItem>(
  signal: T,
  universe: BrainSignalsUniverseResult<unknown> | BrainUnionUniverse,
  opts: {
    climate?: NonNullable<Parameters<typeof evaluateUniverseOpen>[2]>['climate']
    recipeId?: string
  } = {},
): GateEvalResult {
  const loaded = 'items' in universe ? universe.universe : universe
  return evaluateUniverseOpen(signal, loaded, {
    climate: opts.climate,
    recipeId: opts.recipeId ?? 'signals_sell_over_100',
    domain: 'signals',
  })
}
