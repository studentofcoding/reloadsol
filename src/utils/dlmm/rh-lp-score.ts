/**
 * Robinhood LP pool score — same shape as the Meteora `scorePool` (hard floors
 * → weighted parts) but fed by the Pools indexer + Trenches demand, and
 * multiplied by indexer confidence so stale data shrinks every score.
 */
import type { LpTerminalPoolRaw } from '@/utils/dlmm/lp-terminal-pools'
import { lpChurn } from '@/utils/dlmm/lp-terminal-pools'
import { EMPTY_DEMAND, type FomoTokenDemand } from '@/utils/fomo-demand'

export type RhLpScoreConfig = {
  minVolumeUsd: number
  minLpCount: number
  /** Pools flagged singleton with no verified TVL need at least this much liquidity from a secondary source. */
  minVerifiedTvlUsd: number
  maxAbsPriceChangePct: number
  /** Churn above this (adds+removes per LP per day) is treated as farming/unstable. */
  maxChurn: number
  /** Trenches sell/(buy+sell) above this zeroes the pool. */
  maxToxicRatio: number
  weights: {
    feeEff: number
    feeApr: number
    demand: number
    stability: number
  }
}

function envNum(key: string, fallback: number): number {
  const n = Number(process.env[key])
  return Number.isFinite(n) ? n : fallback
}

export function rhLpScoreConfig(): RhLpScoreConfig {
  return {
    minVolumeUsd: envNum('RH_LP_MIN_VOLUME_USD', 25_000),
    minLpCount: envNum('RH_LP_MIN_LP_COUNT', 5),
    minVerifiedTvlUsd: envNum('RH_LP_MIN_VERIFIED_TVL_USD', 10_000),
    maxAbsPriceChangePct: envNum('RH_LP_MAX_ABS_PRICE_CHANGE_PCT', 80),
    maxChurn: envNum('RH_LP_MAX_CHURN', 25),
    maxToxicRatio: envNum('RH_LP_MAX_TOXIC_RATIO', 0.75),
    weights: {
      feeEff: envNum('RH_LP_W_FEE_EFF', 30),
      feeApr: envNum('RH_LP_W_FEE_APR', 30),
      demand: envNum('RH_LP_W_DEMAND', 25),
      stability: envNum('RH_LP_W_STABILITY', 15),
    },
  }
}

export type RhLpFeatures = {
  feeEff: number | null
  feeAprPct: number | null
  churn: number | null
  priceChangePct: number | null
  tvlVerified: boolean
  demandUsd: number
  uniqueBuyers: number
  toxicRatio: number
}

export type RhLpScore = {
  /** 0..100 after confidence multiply; 0 when any hard floor trips. */
  score: number
  raw: number
  confidence: number
  features: RhLpFeatures
  reasons: string[]
}

function isSingleton(pool: LpTerminalPoolRaw): boolean {
  return (pool.risks ?? []).some((r) => r.toLowerCase().includes('singleton'))
}

export function rhLpFeatures(
  pool: LpTerminalPoolRaw,
  demand: FomoTokenDemand = EMPTY_DEMAND,
  /** DexScreener pool liquidity; stands in for TVL when the indexer can't verify it (v4 singleton). */
  secondaryLiquidityUsd: number | null = null,
): RhLpFeatures {
  const vol = Number(pool.vol24hUsd) || 0
  const fees = typeof pool.fees24hUsd === 'number' ? pool.fees24hUsd : null
  const tvl = Number(pool.tvlUsd) || 0
  const tvlVerified = !pool.tvlApprox && tvl > 0
  const tvlForApr = tvlVerified ? tvl : secondaryLiquidityUsd ?? 0
  return {
    feeEff: fees != null && vol > 0 ? fees / vol : null,
    feeAprPct: fees != null && tvlForApr > 0 ? (fees * 365) / tvlForApr * 100 : null,
    churn: lpChurn(pool),
    priceChangePct: pool.priceChangePct ?? null,
    tvlVerified,
    demandUsd: demand.organicBuyUsd,
    uniqueBuyers: demand.uniqueBuyers,
    toxicRatio: demand.toxicRatio,
  }
}

/**
 * confidence ∈ [0,1] from rhIndexerConfidence; secondaryLiquidityUsd lets a
 * Dexscreener/subgraph read rescue a singleton pool whose indexer TVL is null.
 */
export function scoreRhPool(
  pool: LpTerminalPoolRaw,
  opts: {
    confidence: number
    demand?: FomoTokenDemand
    secondaryLiquidityUsd?: number | null
    cfg?: RhLpScoreConfig
  },
): RhLpScore {
  const cfg = opts.cfg ?? rhLpScoreConfig()
  const f = rhLpFeatures(pool, opts.demand, opts.secondaryLiquidityUsd ?? null)
  const reasons: string[] = []
  const zero = (why: string): RhLpScore => ({
    score: 0,
    raw: 0,
    confidence: opts.confidence,
    features: f,
    reasons: [why],
  })

  const vol = Number(pool.vol24hUsd) || 0
  if (vol < cfg.minVolumeUsd) return zero(`volume ${Math.round(vol)} < ${cfg.minVolumeUsd}`)
  if ((pool.lpCount ?? 0) < cfg.minLpCount) return zero(`lp_count ${pool.lpCount ?? 0} < ${cfg.minLpCount}`)
  const secondary = opts.secondaryLiquidityUsd ?? 0
  if (isSingleton(pool) && !f.tvlVerified && secondary < cfg.minVerifiedTvlUsd) {
    return zero('singleton pool without verified TVL')
  }
  if (f.priceChangePct != null && Math.abs(f.priceChangePct) > cfg.maxAbsPriceChangePct) {
    return zero(`|price change| ${f.priceChangePct.toFixed(0)}% > ${cfg.maxAbsPriceChangePct}%`)
  }
  if (f.churn != null && f.churn > cfg.maxChurn) return zero(`churn ${f.churn.toFixed(1)} > ${cfg.maxChurn}`)
  if (f.toxicRatio > cfg.maxToxicRatio) return zero(`toxic flow ${(f.toxicRatio * 100).toFixed(0)}%`)
  if (opts.confidence <= 0) return zero('indexer confidence 0')

  const w = cfg.weights
  // Fee efficiency: 1% of volume → full marks (nominal tiers above that are capped).
  const feeEffPart = f.feeEff == null ? 0 : Math.min(w.feeEff, f.feeEff * 100 * w.feeEff)
  // Fee APR: 100% annualised → full marks; unverified TVL earns nothing here.
  const feeAprPart = f.feeAprPct == null ? 0 : Math.min(w.feeApr, (f.feeAprPct / 100) * w.feeApr)
  // Demand: log-scaled organic buy USD, bonus for breadth of buyers, discounted by toxic ratio.
  const demandBase = f.demandUsd > 0 ? Math.min(1, Math.log10(f.demandUsd) / 5) : 0
  const breadth = Math.min(1, f.uniqueBuyers / 10)
  const demandPart = w.demand * (0.7 * demandBase + 0.3 * breadth) * (1 - f.toxicRatio)
  // Stability: low churn and small price move.
  const churnScore = f.churn == null ? 0.5 : Math.max(0, 1 - f.churn / cfg.maxChurn)
  const moveScore =
    f.priceChangePct == null ? 0.5 : Math.max(0, 1 - Math.abs(f.priceChangePct) / cfg.maxAbsPriceChangePct)
  const stabilityPart = w.stability * (0.5 * churnScore + 0.5 * moveScore)

  const raw = feeEffPart + feeAprPart + demandPart + stabilityPart
  if (f.feeEff == null) reasons.push('no indexer fees')
  if (!f.tvlVerified) reasons.push('tvl unverified')
  if (f.demandUsd === 0) reasons.push('no trenches demand')
  return {
    score: Math.round(raw * opts.confidence * 10) / 10,
    raw: Math.round(raw * 10) / 10,
    confidence: opts.confidence,
    features: f,
    reasons,
  }
}

/** Paper-LP PnL estimate: fee share over elapsed hours minus concentrated IL. */
export function paperLpPnlPct(input: {
  entryPrice: number
  currentPrice: number
  rangePct: number
  fees24hUsd: number
  poolTvlUsd: number
  amountUsd: number
  hoursOpen: number
}): { pnlPct: number; inRange: boolean; feesUsd: number } {
  const r = input.entryPrice > 0 ? input.currentPrice / input.entryPrice : 1
  const inRange = Math.abs(r - 1) * 100 <= input.rangePct
  const share = input.poolTvlUsd > 0 ? input.amountUsd / (input.poolTvlUsd + input.amountUsd) : 0
  const feesUsd = inRange ? share * input.fees24hUsd * (input.hoursOpen / 24) : 0
  // ponytail: full-range IL scaled by 100/rangePct as a concentration proxy; swap in
  // tick-math IL once paper positions carry real tick bounds.
  const ilFull = (2 * Math.sqrt(r)) / (1 + r) - 1
  const il = Math.max(-1, ilFull * Math.min(20, 100 / Math.max(input.rangePct, 5)))
  const pnlPct = (feesUsd / Math.max(input.amountUsd, 1e-9) + il) * 100
  return { pnlPct: Math.round(pnlPct * 100) / 100, inRange, feesUsd }
}
