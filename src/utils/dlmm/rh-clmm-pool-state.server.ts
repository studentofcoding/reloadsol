/**
 * Short-TTL Redis cache for v4 pool slot0/liquidity state (rec 3.2/6.4).
 * Keyed by pool id; repeated list refreshes within the TTL reuse cached
 * pool state instead of re-hitting RPC.
 *
 * Server-only (imports ioredis) — never import from browser bundles.
 */

import type { Hex } from 'viem'
import { cacheGet, cacheSet } from '@/utils/redis-cache'
import type { V4PoolStateSnapshot } from '@/utils/dlmm/rh-clmm/v4'

export const RH_CLMM_POOL_STATE_TTL_SEC = 15
export const RH_CLMM_POOL_STATE_KEY_PREFIX = 'rh-clmm:pool-state:v1:'

export function rhClmmPoolStateCacheKey(poolId: string): string {
  return `${RH_CLMM_POOL_STATE_KEY_PREFIX}${poolId.trim().toLowerCase()}`
}

type Wire = { sqrtPriceX96: string; tick: number; liquidity: string }

function toWire(s: V4PoolStateSnapshot): Wire {
  return {
    sqrtPriceX96: s.sqrtPriceX96.toString(),
    tick: s.tick,
    liquidity: s.liquidity.toString(),
  }
}

function fromWire(w: Wire): V4PoolStateSnapshot | null {
  try {
    return {
      sqrtPriceX96: BigInt(w.sqrtPriceX96),
      tick: Number(w.tick),
      liquidity: BigInt(w.liquidity),
    }
  } catch {
    return null
  }
}

export async function readV4PoolStateCache(
  poolIds: Iterable<string | Hex>,
): Promise<Map<string, V4PoolStateSnapshot>> {
  const out = new Map<string, V4PoolStateSnapshot>()
  for (const poolId of poolIds) {
    const cached = await cacheGet<Wire>(rhClmmPoolStateCacheKey(String(poolId)))
    if (!cached) continue
    const state = fromWire(cached)
    if (state) out.set(String(poolId), state)
  }
  return out
}

export async function writeV4PoolStateCache(
  states: ReadonlyMap<string, V4PoolStateSnapshot>,
): Promise<void> {
  for (const [poolId, state] of states) {
    await cacheSet(
      rhClmmPoolStateCacheKey(poolId),
      toWire(state),
      RH_CLMM_POOL_STATE_TTL_SEC,
    )
  }
}
