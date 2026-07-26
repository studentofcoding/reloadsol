/** Client-safe CLMM live row helpers (no Redis / pg). */

import type { Address } from 'viem'
import type { RhClmmLiveRow, RhClmmPosition } from '@/types/dlmm'
import type { OnChainPosition } from '@/utils/dlmm/rh-clmm/positions'

export function isRhOwnerAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s.trim())
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
