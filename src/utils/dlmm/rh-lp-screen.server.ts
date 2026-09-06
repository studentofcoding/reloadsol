/**
 * RH LP screen cycle (worker `rh_lp_screen`, sim_only): pull the Pools indexer,
 * join Trenches demand, score, persist candidates, then open / manage paper LP
 * rows in dlmm_positions (chain='robinhood') through the shared DLMM reasoner.
 */
import type { DlmmScreenCandidate } from '@/types/dlmm'
import { getLpTerminalIndexerBase } from '@/utils/dlmm/lp-terminal'
import type { LpTerminalPoolRaw, LpTerminalTokenMeta } from '@/utils/dlmm/lp-terminal-pools'
import { pairLabel, tokenSymbol } from '@/utils/dlmm/lp-terminal-pools'
import {
  getPositions,
  insertPosition,
  saveCandidates,
  updatePosition,
} from '@/utils/dlmm/db'
import { decidePositionAction } from '@/utils/dlmm/reasoner'
import { paperLpPnlPct, rhLpScoreConfig, scoreRhPool, type RhLpScore } from '@/utils/dlmm/rh-lp-score'
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

export const RH_LP_CHAIN = 'robinhood'

function envNum(key: string, fallback: number): number {
  const n = Number(process.env[key])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const PAPER = {
  minScore: () => envNum('RH_LP_PAPER_MIN_SCORE', 40),
  maxOpen: () => envNum('RH_LP_PAPER_MAX_OPEN', 3),
  amountUsd: () => envNum('RH_LP_PAPER_AMOUNT_USD', 1000),
  rangePct: () => envNum('RH_LP_PAPER_RANGE_PCT', 15),
  takeProfitPct: () => envNum('RH_LP_PAPER_TP_PCT', 5),
  stopLossPct: () => -envNum('RH_LP_PAPER_SL_PCT', 10),
  oorTimeoutMin: () => envNum('RH_LP_PAPER_OOR_MIN', 60),
}

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

export type RhLpScreenResult = {
  success: true
  confidence: number
  noTrade: boolean
  reasons: string[]
  scored: number
  candidates: number
  opened: number
  decisions: { id: string; pool: string; decision: string; reason: string }[]
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

export async function runRhLpScreen(): Promise<RhLpScreenResult> {
  const { pools, tokens, confidence } = await fetchRhPoolsSnapshot()
  const scored = (await scoreRhPools(pools, confidence.score))
    .filter((s) => s.score.score > 0)
    .sort((a, b) => b.score.score - a.score.score)

  const screenedAt = new Date().toISOString()
  const candidates: DlmmScreenCandidate[] = scored.slice(0, 25).map(({ pool, score }) => ({
    pool_address: pool.address,
    pool_name: pairLabel(pool, tokens),
    token_x_symbol: tokenSymbol(tokens, pool.token0),
    token_y_symbol: tokenSymbol(tokens, pool.token1),
    tvl: Number(pool.tvlUsd) || 0,
    fee_tvl_ratio_24h: score.features.feeAprPct != null ? score.features.feeAprPct / 365 / 100 : 0,
    organic_score: score.features.demandUsd,
    holders: pool.lpCount ?? 0,
    mcap: 0,
    score: score.score,
    screened_at: screenedAt,
    chain: RH_LP_CHAIN,
    confidence: confidence.score,
    features: { ...score.features, raw: score.raw, reasons: score.reasons, proto: pool.proto },
  }))
  await saveCandidates(candidates)

  const decisions = await managePaperPositions(pools, tokens)
  const opened = confidence.noTrade ? 0 : await openPaperPositions(scored, tokens)

  return {
    success: true,
    confidence: confidence.score,
    noTrade: confidence.noTrade,
    reasons: confidence.reasons,
    scored: scored.length,
    candidates: candidates.length,
    opened,
    decisions,
  }
}

/** Live paper rows: 'open' or 'out_of_range' (still deployed, awaiting the reasoner). */
async function livePaperPositions() {
  const all = await getPositions(undefined, RH_LP_CHAIN)
  return all.filter((p) => p.status === 'open' || p.status === 'out_of_range')
}

async function openPaperPositions(
  scored: { pool: LpTerminalPoolRaw; score: RhLpScore }[],
  tokens: Record<string, LpTerminalTokenMeta>,
): Promise<number> {
  const open = await livePaperPositions()
  const held = new Set(open.map((p) => p.pool_address.toLowerCase()))
  let slots = PAPER.maxOpen() - open.length
  let opened = 0
  for (const { pool, score } of scored) {
    if (slots <= 0) break
    if (score.score < PAPER.minScore()) break
    if (held.has(pool.address) || !(pool.priceQuote && pool.priceQuote > 0)) continue
    await insertPosition({
      chain: RH_LP_CHAIN,
      pool_address: pool.address,
      pool_name: pairLabel(pool, tokens),
      token_x_symbol: tokenSymbol(tokens, pool.token0),
      token_y_symbol: tokenSymbol(tokens, pool.token1),
      amount_sol: 0,
      entry_value_usd: PAPER.amountUsd(),
      current_value_usd: PAPER.amountUsd(),
      entry_price: pool.priceQuote,
      range_pct: PAPER.rangePct(),
      take_profit_pct: PAPER.takeProfitPct(),
      stop_loss_pct: PAPER.stopLossPct(),
      oor_timeout_min: PAPER.oorTimeoutMin(),
      status: 'open',
      tx_signature: `rh-lp-paper-${Date.now()}`,
    })
    held.add(pool.address)
    slots -= 1
    opened += 1
  }
  return opened
}

async function managePaperPositions(
  pools: LpTerminalPoolRaw[],
  tokens: Record<string, LpTerminalTokenMeta>,
): Promise<RhLpScreenResult['decisions']> {
  const open = await livePaperPositions()
  if (open.length === 0) return []
  const byAddr = new Map(pools.map((p) => [p.address.toLowerCase(), p]))
  const out: RhLpScreenResult['decisions'] = []
  const now = Date.now()
  for (const pos of open) {
    const pool = byAddr.get(pos.pool_address.toLowerCase())
    // Pool dropped out of the top-150 by fees → no mark; leave untouched this cycle.
    if (!pool || !pool.priceQuote || !pos.entry_price) continue
    const hoursOpen = Math.max(0, (now - new Date(pos.created_at).getTime()) / 36e5)
    const est = paperLpPnlPct({
      entryPrice: pos.entry_price,
      currentPrice: pool.priceQuote,
      rangePct: pos.range_pct ?? PAPER.rangePct(),
      fees24hUsd: pool.fees24hUsd ?? 0,
      poolTvlUsd: Number(pool.tvlUsd) || 0,
      amountUsd: pos.entry_value_usd,
      hoursOpen,
    })
    const oorSince = est.inRange ? null : (pos.oor_since ?? new Date(now).toISOString())
    const oorMinutes = oorSince ? (now - new Date(oorSince).getTime()) / 60_000 : 0
    const decision = await decidePositionAction({
      poolName: pos.pool_name || pairLabel(pool, tokens),
      pnlPct: est.pnlPct,
      inRange: est.inRange,
      oorMinutes,
      oorTimeoutMin: pos.oor_timeout_min,
      takeProfitPct: pos.take_profit_pct,
      stopLossPct: pos.stop_loss_pct,
      feeTvl24h:
        Number(pool.tvlUsd) > 0 ? (pool.fees24hUsd ?? 0) / Number(pool.tvlUsd) : 0,
    })
    const closing = decision.decision === 'CLOSE'
    await updatePosition(pos.id, {
      current_value_usd: pos.entry_value_usd * (1 + est.pnlPct / 100),
      fees_earned_usd: pos.fees_earned_usd + est.feesUsd,
      pnl_pct: est.pnlPct,
      oor_since: oorSince,
      status: closing ? 'closed' : est.inRange ? 'open' : 'out_of_range',
      closed_at: closing ? new Date(now).toISOString() : null,
      last_decision: decision.decision,
      last_decision_reason: decision.reason,
      last_decision_at: new Date(now).toISOString(),
    })
    out.push({ id: pos.id, pool: pos.pool_name, decision: decision.decision, reason: decision.reason })
  }
  return out
}
