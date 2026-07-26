/**
 * Server-side RH CLMM live snapshot: Redis (30s) → DB cold → RPC crawl.
 */

import { createPublicClient, http, type Address } from 'viem'
import { cacheGet, cacheSet } from '@/utils/redis-cache'
import type { RhClmmLiveRow, RhClmmPosition } from '@/types/dlmm'
import {
  listRhClmmPositions,
  upsertRhClmmLiveSnapshots,
} from '@/utils/dlmm/rh-clmm-db'
import { listOwnerPositions } from '@/utils/dlmm/rh-clmm'
import type { OnChainPosition } from '@/utils/dlmm/rh-clmm/positions'
import { RH_CHAIN, getRhRpcUrl } from '@/utils/dlmm/rh-univ2'

export const RH_CLMM_LIVE_TTL_SEC = 30
export const RH_CLMM_LIVE_KEY_PREFIX = 'rh-clmm-live:v1:'

export type RhClmmLiveCachePayload = {
  syncedAt: string
  positions: RhClmmLiveRow[]
}

export function rhClmmLiveCacheKey(owner: string): string {
  return `${RH_CLMM_LIVE_KEY_PREFIX}${owner.trim().toLowerCase()}`
}

export function isRhOwnerAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s.trim())
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

export function markToLiveRow(m: RhClmmPosition): RhClmmLiveRow {
  return {
    tokenId: m.token_id,
    protocol: m.protocol,
    poolAddress: m.pool_address,
    pairLabel:
      m.pair_label ||
      (m.symbol0 && m.symbol1
        ? `${m.symbol0}/${m.symbol1}`
        : `#${m.token_id}`),
    symbol0: m.symbol0 ?? '?',
    symbol1: m.symbol1 ?? '?',
    decimals0: 18,
    decimals1: 18,
    valueUsd: m.current_value_usd || m.entry_value_usd || 0,
    unclaimedFeesUsd: m.unclaimed_fees_usd ?? 0,
    inRange: m.in_range ?? true,
    tickLower: m.tick_lower ?? 0,
    tickUpper: m.tick_upper ?? 0,
    liquidity: m.liquidity ?? '0',
    tokensOwed0: '0',
    tokensOwed1: '0',
    token0: '0x0000000000000000000000000000000000000000',
    token1: '0x0000000000000000000000000000000000000000',
    entryValueUsd: m.entry_value_usd,
    pnlPct: Number.isFinite(m.pnl_pct) ? m.pnl_pct : null,
    createdAt: m.created_at,
    markId: m.id,
  }
}

export function liveRowToOnChain(r: RhClmmLiveRow): OnChainPosition {
  return {
    tokenId: BigInt(r.tokenId),
    chainId: 4663,
    protocol: r.protocol,
    token0: r.token0 as Address,
    token1: r.token1 as Address,
    fee: 0,
    tickLower: r.tickLower,
    tickUpper: r.tickUpper,
    liquidity: BigInt(r.liquidity || '0'),
    tokensOwed0: BigInt(r.tokensOwed0 || '0'),
    tokensOwed1: BigInt(r.tokensOwed1 || '0'),
    symbol0: r.symbol0,
    symbol1: r.symbol1,
    decimals0: r.decimals0,
    decimals1: r.decimals1,
    amount0: BigInt(0),
    amount1: BigInt(0),
    inRange: r.inRange,
    currentTick: 0,
    poolAddress: r.poolAddress || null,
    valueUsd: r.valueUsd,
    unclaimedFeesUsd: r.unclaimedFeesUsd,
    amount0Human: 0,
    amount1Human: 0,
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
  const markByKey = new Map(
    marks.map((m) => [`${m.protocol}:${m.token_id}`, m] as const),
  )

  const publicClient = createPublicClient({
    chain: RH_CHAIN,
    transport: http(getRhRpcUrl()),
  })

  const onChain = await listOwnerPositions(
    { publicClient, owner: ownerAddr },
    knownV4Ids,
  )

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
