import type { Address } from 'viem'
import type {
  LpTerminalPoolRaw,
  LpTerminalProto,
  LpTerminalTokenMeta,
} from '@/utils/dlmm/lp-terminal-pools'
import {
  fetchUniswapV3PoolsForToken,
  fetchUniswapV4PoolsForToken,
  type DexPair,
} from '@/utils/dlmm/rh-clmm/dexscreener'
import {
  fetchTopV4Pools,
  type ExploreV4Pool,
} from '@/utils/dlmm/rh-clmm/uniswapExplore'
import { RH_CHAIN_ID, RH_USDG, RH_WETH } from '@/utils/dlmm/rh-univ2'

const ZERO = '0x0000000000000000000000000000000000000000'
const RH = RH_CHAIN_ID

export type LpFallbackWant = '' | LpTerminalProto

export function dexPairToLpPool(
  proto: 'univ3' | 'univ4',
  p: DexPair,
): LpTerminalPoolRaw {
  const feeRaw = Number(p.feeTier)
  return {
    proto,
    address: p.pairAddress.toLowerCase(),
    token0: p.baseToken.address.toLowerCase(),
    token1: p.quoteToken.address.toLowerCase(),
    feePpm: Number.isFinite(feeRaw) && feeRaw > 0 ? feeRaw : null,
    tvlUsd: p.liquidity?.usd ?? 0,
    vol24hUsd: p.volume?.h24 ?? 0,
  }
}

export function dexPairTokenMeta(p: DexPair): Record<string, LpTerminalTokenMeta> {
  const t0 = p.baseToken.address.toLowerCase()
  const t1 = p.quoteToken.address.toLowerCase()
  return {
    [t0]: { address: t0, symbol: p.baseToken.symbol },
    [t1]: { address: t1, symbol: p.quoteToken.symbol },
  }
}

export function exploreV4ToLpPool(p: ExploreV4Pool): LpTerminalPoolRaw | null {
  const t0 = (p.currency0 ?? ZERO).toLowerCase()
  const t1 = (p.currency1 ?? ZERO).toLowerCase()
  if (!p.poolId) return null
  return {
    proto: 'univ4',
    address: p.poolId.toLowerCase(),
    token0: t0,
    token1: t1,
    feePpm: p.fee > 0 ? p.fee : null,
    tvlUsd: p.tvlUsd,
    vol24hUsd: 0,
  }
}

export function exploreV4TokenMeta(p: ExploreV4Pool): Record<string, LpTerminalTokenMeta> {
  const t0 = (p.currency0 ?? ZERO).toLowerCase()
  const t1 = (p.currency1 ?? ZERO).toLowerCase()
  return {
    [t0]: { address: t0, symbol: p.symbol0 },
    [t1]: { address: t1, symbol: p.symbol1 },
  }
}

function wantsProto(want: LpFallbackWant, proto: LpTerminalProto): boolean {
  return want === '' || want === proto
}

export function mergeLpFallbackCatalog(opts: {
  want: LpFallbackWant
  univ2: LpTerminalPoolRaw[]
  univ3: LpTerminalPoolRaw[]
  univ4: LpTerminalPoolRaw[]
  tokens: Record<string, LpTerminalTokenMeta>
  minTvl?: number
}): {
  pools: LpTerminalPoolRaw[]
  tokens: Record<string, LpTerminalTokenMeta>
  totals: { univ2: number; univ3: number; univ4: number }
  count: number
} {
  const min = opts.minTvl != null && Number.isFinite(opts.minTvl) ? opts.minTvl : 0
  const seen = new Set<string>()
  const pools: LpTerminalPoolRaw[] = []
  const push = (proto: LpTerminalProto, list: LpTerminalPoolRaw[]) => {
    if (!wantsProto(opts.want, proto)) return
    for (const p of list) {
      const key = `${String(p.proto).toLowerCase()}:${p.address.toLowerCase()}`
      if (seen.has(key)) continue
      if (min > 0 && (Number(p.tvlUsd) || 0) < min) continue
      seen.add(key)
      pools.push({ ...p, proto })
    }
  }
  push('univ2', opts.univ2)
  push('univ3', opts.univ3)
  push('univ4', opts.univ4)
  const totals = {
    univ2: pools.filter((p) => p.proto === 'univ2').length,
    univ3: pools.filter((p) => p.proto === 'univ3').length,
    univ4: pools.filter((p) => p.proto === 'univ4').length,
  }
  return { pools, tokens: opts.tokens, totals, count: pools.length }
}

function tokenQueries(q?: string): Address[] {
  const raw = q?.trim() ?? ''
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) return [raw.toLowerCase() as Address]
  return [RH_WETH, RH_USDG]
}

function matchesQ(pool: LpTerminalPoolRaw, tokens: Record<string, LpTerminalTokenMeta>, q?: string): boolean {
  const raw = q?.trim().toLowerCase()
  if (!raw || /^0x[a-fA-F0-9]{40}$/.test(raw)) return true
  const s0 = (tokens[pool.token0]?.symbol ?? '').toLowerCase()
  const s1 = (tokens[pool.token1]?.symbol ?? '').toLowerCase()
  return (
    s0.includes(raw) ||
    s1.includes(raw) ||
    pool.address.toLowerCase().includes(raw) ||
    pool.token0.toLowerCase().includes(raw) ||
    pool.token1.toLowerCase().includes(raw)
  )
}

export async function fetchClmmPoolFallbacks(q?: string): Promise<{
  univ3: LpTerminalPoolRaw[]
  univ4: LpTerminalPoolRaw[]
  tokens: Record<string, LpTerminalTokenMeta>
}> {
  const tokens: Record<string, LpTerminalTokenMeta> = {}
  const univ3: LpTerminalPoolRaw[] = []
  const univ4: LpTerminalPoolRaw[] = []
  const queries = tokenQueries(q)

  await Promise.all(
    queries.map(async (token) => {
      const [v3r, v4r, exr] = await Promise.allSettled([
        fetchUniswapV3PoolsForToken(RH, token),
        fetchUniswapV4PoolsForToken(RH, token),
        fetchTopV4Pools(RH, token, 25),
      ])
      if (v3r.status === 'fulfilled') {
        for (const p of v3r.value) {
          univ3.push(dexPairToLpPool('univ3', p))
          Object.assign(tokens, dexPairTokenMeta(p))
        }
      }
      if (v4r.status === 'fulfilled') {
        for (const p of v4r.value) {
          univ4.push(dexPairToLpPool('univ4', p))
          Object.assign(tokens, dexPairTokenMeta(p))
        }
      }
      if (exr.status === 'fulfilled') {
        for (const p of exr.value) {
          const row = exploreV4ToLpPool(p)
          if (!row) continue
          univ4.push(row)
          Object.assign(tokens, exploreV4TokenMeta(p))
        }
      }
    }),
  )

  const filter = (list: LpTerminalPoolRaw[]) =>
    list.filter((p) => matchesQ(p, tokens, q))
  return { univ3: filter(univ3), univ4: filter(univ4), tokens }
}
