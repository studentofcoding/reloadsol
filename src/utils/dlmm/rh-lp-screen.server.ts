/**
 * RH LP pool snapshot + scoring helpers used by /api/dlmm/lp-terminal-pools.
 * (The `rh_lp_screen` cron worker that also opened/managed paper LP rows was removed.)
 */
import { getLpTerminalIndexerBase } from '@/utils/dlmm/lp-terminal'
import type { LpTerminalPoolRaw, LpTerminalTokenMeta } from '@/utils/dlmm/lp-terminal-pools'
import { rhLpScoreConfig, scoreRhPool, type RhLpScore } from '@/utils/dlmm/rh-lp-score'
import {
  rhIndexerConfidence,
  rhPoolsToCatalog,
  rhPoolsUrl,
  type RhIndexerStatus,
  type RhPoolsResponse,
} from '@/utils/dlmm/rh-pools-indexer'
import { fomoTokenDemand24h } from '@/utils/fomo-demand'
import { RH_CHAIN_ID } from '@/utils/dlmm/rh-clmm/config'
import { fetchPairLiquidityUsd } from '@/utils/dlmm/rh-clmm/dexscreener'

async function fetchJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`Indexer HTTP ${res.status}`)
  const text = await res.text()
  if (!text.trim() || text.trim().startsWith('<')) return null
  return JSON.parse(text) as T
}

export async function fetchRhPoolsSnapshot(limit = 150): Promise<{
  pools: LpTerminalPoolRaw[]
  tokens: Record<string, LpTerminalTokenMeta>
  confidence: ReturnType<typeof rhIndexerConfidence>
}> {
  const base = getLpTerminalIndexerBase()
  const [body, status] = await Promise.all([
    fetchJson<RhPoolsResponse>(rhPoolsUrl(base, { sort: 'fees', limit, offset: 0 })),
    fetchJson<RhIndexerStatus>(`${base}/api/lp/status`).catch(() => null),
  ])
  if (!body?.rows) throw new Error('Indexer body missing rows')
  const cat = rhPoolsToCatalog(body)
  return { pools: cat.pools, tokens: cat.tokens, confidence: rhIndexerConfidence(status) }
}

/** Join Trenches demand and score every pool (unsorted, zeros kept). */
export async function scoreRhPools(
  pools: LpTerminalPoolRaw[],
  confidence: number,
): Promise<{ pool: LpTerminalPoolRaw; score: RhLpScore }[]> {
  // Singleton (v4) pools report no TVL from the indexer; DexScreener's per-pool
  // liquidity is the secondary source that lets them clear the verified-TVL floor.
  const unverified = pools.filter((p) => p.tvlApprox || !(Number(p.tvlUsd) > 0)).map((p) => p.address)
  const [demand, secondaryTvl] = await Promise.all([
    fomoTokenDemand24h(pools.flatMap((p) => [p.token0, p.token1])),
    unverified.length > 0 ? fetchPairLiquidityUsd(RH_CHAIN_ID, unverified) : new Map<string, number>(),
  ])
  const cfg = rhLpScoreConfig()
  return pools.map((pool) => {
    // Demand attaches to the non-quote leg; take the max so USDG pairs work.
    const d0 = demand.get(pool.token0)
    const d1 = demand.get(pool.token1)
    const d = (d0?.organicBuyUsd ?? 0) >= (d1?.organicBuyUsd ?? 0) ? d0 : d1
    const secondaryLiquidityUsd = secondaryTvl.get(pool.address.toLowerCase()) ?? null
    return { pool, score: scoreRhPool(pool, { confidence, demand: d, cfg, secondaryLiquidityUsd }) }
  })
}
