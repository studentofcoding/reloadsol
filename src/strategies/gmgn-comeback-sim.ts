/** Open a gmgn-sim paper buy when Radar comeback confirms (allowSimReopen). */

import { getActiveGmgnForSim } from './load-gmgn'
import { fetchTradingRecordsForWallet } from './db'
import { buildFullEntryFeatureSnapshot } from './resolve-entry-snapshot'
import type { GmgnRadarReview } from './gmgn-radar-review'
import { computeOpenSimCycle } from '@/utils/simulation-trades'
import { buildTradingRecord, insertTradingRecord } from '@/utils/trading-records-db'
import { getSolPriceUSD } from '@/utils/solana'

const GMGN_SIM_WALLET = process.env.GMGN_SIM_WALLET_ADDRESS || 'gmgn-sim'

/**
 * If an active gmgn sim strategy has room and mint is not already open, open a paper buy.
 * Returns strategy id opened, or null if skipped.
 */
export async function maybeOpenGmgnComebackSim(params: {
  tokenAddress: string
  symbol: string
  priceUsd: number | null
  mcapUsd: number | null
  review: GmgnRadarReview
  sm: number
  kol: number
  preferredStrategyId?: string
}): Promise<{ opened: boolean; strategyId: string | null; reason: string }> {
  const strategies = await getActiveGmgnForSim()
  if (strategies.length === 0) {
    return { opened: false, strategyId: null, reason: 'no active gmgn sim strategy' }
  }

  const preferred = params.preferredStrategyId
    ? strategies.find((s) => s.id === params.preferredStrategyId)
    : null
  const strategy =
    preferred ??
    strategies.find((s) => s.id === 'gmgn_sm_kol_combined') ??
    strategies[0]

  const records = await fetchTradingRecordsForWallet(GMGN_SIM_WALLET)
  const openMints = new Set<string>()
  let openCount = 0
  const seen = new Set<string>()
  for (const r of records) {
    if (!r.is_simulation || r.bot_strategy !== strategy.id) continue
    for (const t of r.tokens ?? []) {
      if (seen.has(t.mintAddress)) continue
      const cycle = computeOpenSimCycle(records, t.mintAddress)
      if (!cycle || cycle.simulationType !== 'strategy') continue
      seen.add(t.mintAddress)
      openMints.add(t.mintAddress)
      openCount++
    }
  }

  if (openMints.has(params.tokenAddress)) {
    return { opened: false, strategyId: strategy.id, reason: 'already open' }
  }
  if (openCount >= strategy.config.execution.maxOpenPositions) {
    return { opened: false, strategyId: strategy.id, reason: 'max open positions' }
  }

  const solAmount = strategy.config.execution.simBuySol
  const solPrice = await getSolPriceUSD()
  const priceUsd =
    params.priceUsd != null && params.priceUsd > 0 ? params.priceUsd : 0.000001
  const tokenAmount =
    priceUsd > 0 && solPrice > 0 ? (solAmount * solPrice) / priceUsd : solAmount * 1_000_000

  const entryAt = new Date().toISOString()
  const entryFeatures: Record<string, unknown> = {
    domain: 'gmgn',
    strategy_id: strategy.id,
    radar_action: params.review.action,
    radar_score: params.review.score,
    radar_summary: params.review.summary,
    radar_comeback: 1,
    radar_sm_peak: params.sm,
    radar_kol_peak: params.kol,
    gmgn_market_cap_usd: params.mcapUsd,
  }

  const fullFeatures = await buildFullEntryFeatureSnapshot(
    params.tokenAddress,
    {
      entryAt,
      entryMcap: params.mcapUsd,
      topHoldersPct: null,
      tokenSymbol: params.symbol,
    },
    entryFeatures,
  )

  const record = buildTradingRecord({
    walletAddress: GMGN_SIM_WALLET,
    operationType: 'buy',
    is_simulation: true,
    simulation_type: 'strategy',
    bot_strategy: strategy.id,
    tokens: [
      {
        mintAddress: params.tokenAddress,
        symbol: params.symbol,
        tokenAmount,
        solAmount,
        priceUsd,
        solPrice,
      },
    ],
    successCount: 1,
    failureCount: 0,
    totalTokens: 1,
    solAmount,
    feesPaid: 0,
    solPriceUsd: solPrice,
    signatures: [`gmgn-sim-comeback-${Date.now()}`],
    status: 'tracking',
    trading_simulation: {
      entry_at: entryAt,
      entry_price_usd: priceUsd,
      entry_features: {
        ...fullFeatures,
        entry_at: entryAt,
        initial_price_usd: priceUsd,
        token_symbol: params.symbol,
        radar_comeback: 1,
      },
    },
  })

  await insertTradingRecord(record)
  return { opened: true, strategyId: strategy.id, reason: 'opened' }
}
