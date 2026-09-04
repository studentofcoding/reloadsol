import { describe, expect, it } from 'vitest'
import {
  RH_CLMM_POOL_STATE_KEY_PREFIX,
  RH_CLMM_POOL_STATE_TTL_SEC,
  rhClmmPoolStateCacheKey,
} from '@/utils/dlmm/rh-clmm-pool-state.server'

const readSrc = async (rel: string) => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  return readFileSync(join(process.cwd(), rel), 'utf8')
}

describe('rh-clmm v4 list multicall batching (item 3 / rec 3.2, 6.4)', () => {
  it('listV4Positions batches reads via Multicall3 with allowFailure', async () => {
    const src = await readSrc('src/utils/dlmm/rh-clmm/v4.ts')
    expect(src).toContain("'0xca11bde06177c9f5c1b90fd73a40a41c9d3cCA11'")
    expect(src).toContain('allowFailure: true')
    expect(src).toContain('multicallAddress: MULTICALL3')
    expect(src).toContain("functionName: 'getPoolAndPositionInfo'")
    expect(src).toContain("functionName: 'getPositionLiquidity'")
    expect(src).toContain("functionName: 'getSlot0'")
    expect(src).toContain("functionName: 'getLiquidity'")
    expect(src).toContain("functionName: 'getFeeGrowthInside'")
    expect(src).toContain("functionName: 'getPositionInfo'")
  })

  it('v4.ts stays browser-safe (no redis/ioredis imports)', async () => {
    const src = await readSrc('src/utils/dlmm/rh-clmm/v4.ts')
    expect(src).not.toMatch(/from 'ioredis'/)
    expect(src).not.toMatch(/redis-cache/)
  })

  it('accepts ledger hints to skip getPoolAndPositionInfo discovery reads', async () => {
    const src = await readSrc('src/utils/dlmm/rh-clmm/v4.ts')
    expect(src).toContain('export type V4LedgerHint')
    expect(src).toContain('export type V4ListExtras')
    expect(src).toContain('extras.ledgerHints')
    expect(src).toContain('extras.knownPoolStates')
    expect(src).toContain('extras.poolStatesOut')
    // hint present → no info call for that stage
    expect(src).toContain('if (s.poolKey == null || s.tickLower == null || s.tickUpper == null) {')
  })

  it('threads extras through positions.ts and index.ts', async () => {
    const positions = await readSrc('src/utils/dlmm/rh-clmm/positions.ts')
    expect(positions).toContain('v4Extras?: V4ListExtras')
    expect(positions).toContain('listV4Positions(chainId, knownV4TokenIds, v4Extras)')
    const index = await readSrc('src/utils/dlmm/rh-clmm/index.ts')
    expect(index).toContain('v4Extras?: V4ListExtras')
    expect(index).toContain('listPositions(RH_CHAIN_ID, knownV4TokenIds, v4Extras)')
  })
})

describe('rh-clmm pool-state Redis cache (rec 3.2)', () => {
  it('builds lowercased cache keys with a 15s TTL', () => {
    expect(RH_CLMM_POOL_STATE_TTL_SEC).toBe(15)
    expect(rhClmmPoolStateCacheKey('0xABCDEF')).toBe(
      `${RH_CLMM_POOL_STATE_KEY_PREFIX}0xabcdef`,
    )
  })

  it('cache helper is server-only and reuses redis-cache', async () => {
    const src = await readSrc('src/utils/dlmm/rh-clmm-pool-state.server.ts')
    expect(src).toContain("from '@/utils/redis-cache'")
    expect(src).not.toContain("from './rh-clmm/clients'")
  })

  it('crawlRhClmmLive uses ledger hints + pool-state cache', async () => {
    const src = await readSrc('src/utils/dlmm/rh-clmm-live.ts')
    expect(src).toContain('readV4PoolStateCache')
    expect(src).toContain('writeV4PoolStateCache')
    expect(src).toContain('{ ledgerHints, knownPoolStates, poolStatesOut }')
    expect(src).toContain('computePoolId(key)')
    // Redis → DB → background-revalidate tiers preserved via the loader helper
    expect(src).toContain('readRhClmmLiveRedis')
    expect(src).toContain('readRhClmmLiveFromDb')
    expect(src).toContain('void refreshRhClmmLive(owner).catch')
  })
})
