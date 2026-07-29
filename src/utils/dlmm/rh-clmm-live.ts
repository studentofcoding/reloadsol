/**
 * Server-side RH CLMM live snapshot: Redis (30s) → DB cold → RPC crawl.
 * Do not import this from client components (pulls ioredis / pg).
 */

import { createPublicClient, http, type Address } from 'viem'
import { cacheGet, cacheSet, cacheDel } from '@/utils/redis-cache'
import type { RhClmmLiveRow, RhClmmPosition, RhV4PoolKeyJson } from '@/types/dlmm'
import {
  listRhClmmPositions,
  upsertRhClmmLiveSnapshots,
} from '@/utils/dlmm/rh-clmm-db'
import { listOwnerPositions } from '@/utils/dlmm/rh-clmm'
import type { OnChainPosition } from '@/utils/dlmm/rh-clmm/positions'
import {
  computePoolId,
  type V4LedgerHint,
  type V4PoolKey,
  type V4PoolStateSnapshot,
} from '@/utils/dlmm/rh-clmm/v4'
import {
  readV4PoolStateCache,
  writeV4PoolStateCache,
} from '@/utils/dlmm/rh-clmm-pool-state.server'
import { RH_CHAIN, getRhRpcUrl } from '@/utils/dlmm/rh-univ2'
import { markToLiveRow } from '@/utils/dlmm/rh-clmm-live-row'

export {
  isRhOwnerAddress,
  markToLiveRow,
  liveRowToOnChain,
} from '@/utils/dlmm/rh-clmm-live-row'

export const RH_CLMM_LIVE_TTL_SEC = 30
export const RH_CLMM_LIVE_KEY_PREFIX = 'rh-clmm-live:v1:'

export type RhClmmLiveCachePayload = {
  syncedAt: string
  positions: RhClmmLiveRow[]
}

export function rhClmmLiveCacheKey(owner: string): string {
  return `${RH_CLMM_LIVE_KEY_PREFIX}${owner.trim().toLowerCase()}`
}

function onChainToLiveRow(
  p: OnChainPosition,
  mark?: RhClmmPosition,
): RhClmmLiveRow {
  const entry = mark?.entry_value_usd ?? 0
  const pnl =
    entry > 0
      ? ((p.valueUsd - entry) / entry) * 100
      : (mark?.pnl_pct ?? null)
  return {
    tokenId: p.tokenId.toString(),
    protocol: p.protocol,
    poolAddress: String(p.poolAddress ?? mark?.pool_address ?? ''),
    pairLabel: `${p.symbol0}/${p.symbol1}`,
    symbol0: p.symbol0,
    symbol1: p.symbol1,
    decimals0: p.decimals0,
    decimals1: p.decimals1,
    valueUsd: p.valueUsd,
    unclaimedFeesUsd: p.unclaimedFeesUsd,
    inRange: p.inRange,
    tickLower: p.tickLower,
    tickUpper: p.tickUpper,
    liquidity: p.liquidity.toString(),
    tokensOwed0: p.tokensOwed0.toString(),
    tokensOwed1: p.tokensOwed1.toString(),
    token0: p.token0,
    token1: p.token1,
    entryValueUsd: entry || undefined,
    pnlPct: pnl != null && Number.isFinite(pnl) ? pnl : null,
    createdAt: mark?.created_at ?? null,
    markId: mark?.id ?? null,
  }
}

/** Ledger pool_key (rec 3.3) → typed V4PoolKey; null when incomplete. */
function ledgerPoolKey(mark: RhClmmPosition): V4PoolKey | null {
  const k = mark.pool_key as RhV4PoolKeyJson | null | undefined
  if (!k) return null
  if (!k.currency0 || !k.currency1 || !k.hooks) return null
  if (!Number.isFinite(k.fee) || !Number.isFinite(k.tickSpacing)) return null
  return {
    currency0: k.currency0 as Address,
    currency1: k.currency1 as Address,
    fee: Number(k.fee),
    tickSpacing: Number(k.tickSpacing),
    hooks: k.hooks as Address,
  }
}

export async function crawlRhClmmLive(
  owner: string,
): Promise<RhClmmLiveRow[]> {
  const ownerAddr = owner.trim() as Address
  const marks = await listRhClmmPositions('open', ownerAddr)
  const knownV4Ids = marks
    .filter((m) => m.protocol === 'v4')
    .map((m) => BigInt(m.token_id))
  const markByKey = new Map<string, RhClmmPosition>()
  for (const m of marks) {
    markByKey.set(`${m.protocol}:${m.token_id}`, m)
  }

  // Ledger hints skip per-position getPoolAndPositionInfo discovery reads;
  // cached pool state skips slot0/liquidity reads within the short TTL.
  const ledgerHints: V4LedgerHint[] = []
  const ledgerPoolIds: string[] = []
  for (const m of marks) {
    if (m.protocol !== 'v4') continue
    const key = ledgerPoolKey(m)
    if (!key || m.tick_lower == null || m.tick_upper == null) continue
    ledgerHints.push({
      tokenId: BigInt(m.token_id),
      poolKey: key,
      tickLower: m.tick_lower,
      tickUpper: m.tick_upper,
    })
    ledgerPoolIds.push(computePoolId(key))
  }
  const knownPoolStates = await readV4PoolStateCache(ledgerPoolIds)
  const poolStatesOut = new Map<string, V4PoolStateSnapshot>()

  const publicClient = createPublicClient({
    chain: RH_CHAIN,
    transport: http(getRhRpcUrl()),
  })

  const onChain = await listOwnerPositions(
    { publicClient, owner: ownerAddr },
    knownV4Ids,
    { ledgerHints, knownPoolStates, poolStatesOut },
  )

  // Persist freshly read pool states for the next refresh (best-effort).
  if (poolStatesOut.size > 0) {
    await writeV4PoolStateCache(poolStatesOut).catch((e) => {
      console.warn(
        '[rh-clmm-live] pool-state cache write failed',
        e instanceof Error ? e.message : e,
      )
    })
  }

  return onChain.map((p) => {
    const key = `${p.protocol}:${p.tokenId.toString()}`
    return onChainToLiveRow(p, markByKey.get(key))
  })
}

export async function writeRhClmmLiveCache(
  owner: string,
  positions: RhClmmLiveRow[],
): Promise<RhClmmLiveCachePayload> {
  const payload: RhClmmLiveCachePayload = {
    syncedAt: new Date().toISOString(),
    positions,
  }
  await cacheSet(rhClmmLiveCacheKey(owner), payload, RH_CLMM_LIVE_TTL_SEC)
  await upsertRhClmmLiveSnapshots(owner, positions)
  return payload
}

export async function readRhClmmLiveRedis(
  owner: string,
): Promise<RhClmmLiveCachePayload | null> {
  return cacheGet<RhClmmLiveCachePayload>(rhClmmLiveCacheKey(owner))
}

/** Drop Redis live snapshot so the next poll cannot resurrect a closed NFT. */
export async function invalidateRhClmmLiveCache(owner: string): Promise<void> {
  const trimmed = owner.trim()
  if (!trimmed) return
  await cacheDel(rhClmmLiveCacheKey(trimmed))
}

export async function readRhClmmLiveFromDb(
  owner: string,
): Promise<RhClmmLiveRow[]> {
  const marks = await listRhClmmPositions('open', owner)
  return marks.map(markToLiveRow)
}

/** Crawl + write Redis/DB. Safe to fire-and-forget. */
export async function refreshRhClmmLive(
  owner: string,
): Promise<RhClmmLiveCachePayload> {
  const positions = await crawlRhClmmLive(owner)
  return writeRhClmmLiveCache(owner, positions)
}
