import { describe, expect, it } from 'vitest'
import type { DexPair } from './rh-clmm/dexscreener'
import {
  dexPairToLpPool,
  exploreV4ToLpPool,
  mergeLpFallbackCatalog,
} from './lp-terminal-pools-fallback'

const dex = (over: Partial<DexPair> & Pick<DexPair, 'pairAddress'>): DexPair => ({
  chainId: 'robinhood',
  dexId: 'uniswap',
  labels: ['v3'],
  baseToken: { address: '0xaaa0000000000000000000000000000000000001', symbol: 'PEPE', name: 'PEPE' },
  quoteToken: { address: '0xbbb0000000000000000000000000000000000002', symbol: 'USDG', name: 'USDG' },
  liquidity: { usd: 50_000 },
  volume: { h24: 1_000 },
  ...over,
})

describe('mergeLpFallbackCatalog', () => {
  it('unions v2/v3/v4 for ALL and filters by proto', () => {
    const univ2 = [
      {
        proto: 'univ2' as const,
        address: '0x2220000000000000000000000000000000000002',
        token0: '0xa',
        token1: '0xb',
        tvlUsd: 10,
      },
    ]
    const univ3 = [dexPairToLpPool('univ3', dex({ pairAddress: '0x3330000000000000000000000000000000000003' }))]
    const univ4 = [
      exploreV4ToLpPool({
        poolId: '0x4444000000000000000000000000000000000000000000000000000000004444',
        fee: 3000,
        tvlUsd: 9,
        currency0: '0xaaa0000000000000000000000000000000000001',
        currency1: '0xbbb0000000000000000000000000000000000002',
        symbol0: 'PEPE',
        symbol1: 'USDG',
      })!,
    ]
    const all = mergeLpFallbackCatalog({
      want: '',
      univ2,
      univ3,
      univ4,
      tokens: {},
    })
    expect(all.totals).toEqual({ univ2: 1, univ3: 1, univ4: 1 })
    expect(all.count).toBe(3)

    const onlyV4 = mergeLpFallbackCatalog({
      want: 'univ4',
      univ2,
      univ3,
      univ4,
      tokens: {},
    })
    expect(onlyV4.pools.every((p) => p.proto === 'univ4')).toBe(true)
    expect(onlyV4.totals.univ4).toBe(1)
    expect(onlyV4.totals.univ3).toBe(0)
  })
})

describe('lp-terminal-pools route fallback', () => {
  it('does not 502 solely because proto is univ3 or univ4', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(
      join(process.cwd(), 'src/app/api/dlmm/lp-terminal-pools/route.ts'),
      'utf8',
    )
    expect(src).not.toMatch(/if \(proto && proto !== 'univ2'\)/)
    expect(src).toContain('mergeLpFallbackCatalog')
    expect(src).toContain('fetchClmmPoolFallbacks')
  })
})
