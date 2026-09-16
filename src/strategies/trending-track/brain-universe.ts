/**
 * Opt-in trending/assign universe from market-brain GET /union (membership).
 *
 * Default path stays Jupiter toptrending/1h. Enable with:
 *   MARKET_BRAIN_TRENDING=1
 *   MARKET_BRAIN_TOKEN=<BRAIN_READ_TOKEN>
 *
 * When enabled, Jupiter pools are intersected with /union mints (membership).
 * Brain fetch failures fail soft and keep the Jupiter list. Live execute is unchanged.
 */

import type { JupiterPool } from '@/types'
import {
  fetchBrainUnion,
  isMarketBrainTrendingEnabled,
  marketBrainTrendingSkipReason,
  type MarketBrainFetchOpts,
} from '@/utils/market-brain'

export type PoolWithMint = {
  baseAsset?: { id?: string | null } | null
}

export type BrainTrendingUniverseResult<T> = {
  pools: T[]
  applied: boolean
  source: 'jupiter' | 'union'
  kept: number
  total: number
  unionSize: number
  error?: string
}

export function poolMint(pool: PoolWithMint | null | undefined): string | null {
  const id = pool?.baseAsset?.id
  if (typeof id !== 'string') return null
  const trimmed = id.trim()
  return trimmed ? trimmed : null
}

export function filterPoolsByUnionMembership<T extends PoolWithMint>(
  pools: T[],
  unionMints: Iterable<string>,
): T[] {
  const membership = new Set<string>()
  for (const mint of unionMints) {
    const trimmed = mint?.trim()
    if (trimmed) membership.add(trimmed)
  }
  if (membership.size === 0) return []
  return pools.filter((pool) => {
    const mint = poolMint(pool)
    return mint != null && membership.has(mint)
  })
}

/**
 * If MARKET_BRAIN_TRENDING=1 and a token is configured, keep only Jupiter pools
 * whose mint is on brain `/union`. Otherwise return pools unchanged.
 */
export async function applyBrainTrendingUniverse<T extends PoolWithMint = JupiterPool>(
  pools: T[],
  opts: MarketBrainFetchOpts = {},
): Promise<BrainTrendingUniverseResult<T>> {
  const total = pools.length
  const skip = marketBrainTrendingSkipReason(opts)
  if (skip) {
    return {
      pools,
      applied: false,
      source: 'jupiter',
      kept: total,
      total,
      unionSize: 0,
      error: skip,
    }
  }
  if (!isMarketBrainTrendingEnabled(opts)) {
    return {
      pools,
      applied: false,
      source: 'jupiter',
      kept: total,
      total,
      unionSize: 0,
    }
  }

  const union = await fetchBrainUnion(opts)
  if (!union.ok) {
    return {
      pools,
      applied: false,
      source: 'jupiter',
      kept: total,
      total,
      unionSize: 0,
      error: union.error,
    }
  }

  const filtered = filterPoolsByUnionMembership(pools, union.data.mints)
  return {
    pools: filtered,
    applied: true,
    source: 'union',
    kept: filtered.length,
    total,
    unionSize: union.data.mints.length,
  }
}
