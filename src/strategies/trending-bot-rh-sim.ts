/**
 * Robinhood twin of the trending_bot cycle: paper-only, GMGN market rank as the
 * candidate source, ETH-denominated sizing. The Solana cycle in
 * /api/trending/track keeps its Jupiter list, tracker table and live wallet —
 * none of that exists on robinhood, so RH runs on trading_records alone.
 */

import { fetchTradingRecordsForWallet } from './db'
import { decideRhTrendingExit } from './exit-ladder'
import { getActiveStrategiesWithState } from './load-strategy'
import { recordTrendingBotOutcome } from './outcomes'
import { RH_MAX_OPEN_POSITIONS_DEFAULT } from './registry'
import { simWalletForChain, TRENDING_BOT_SIM_WALLET } from './sim-wallets'
import type { TrendingBotStrategy } from './types'
import { getFilteredGmgnTrending } from '@/utils/gmgn-trending-feed'
import { getNativeUsd } from '@/utils/native-usd'
import { getOpenPositionPrices } from '@/utils/open-position-prices'
import {
  computeOpenSimCycles,
  type OpenSimCycle,
} from '@/utils/simulation-trades'
import { buildTradingRecord, insertTradingRecord } from '@/utils/trading-records-db'
import { log } from '@/utils/unified-logger'

// Re-export so existing consumers/tests keep their import path.
export { decideRhTrendingExit }

const CHAIN = 'robinhood' as const

const SIM_WALLET = simWalletForChain(TRENDING_BOT_SIM_WALLET, CHAIN)

type OpenPosition = {
  mintAddress: string
  symbol: string
  entryAt: string | null
  entryPriceUsd: number
  tp1Done: boolean
  entryFeatures: Record<string, unknown>
  cycle: OpenSimCycle
}

type Records = Awaited<ReturnType<typeof fetchTradingRecordsForWallet>>

export type RhTrendingSimResult = {
  strategyId: string
  chain: typeof CHAIN
  candidates: number
  opened: number
  closed: number
  skipped: string[]
}

/**
 * Single-pass position reconstruction: group records by mint once (candidate
 * discovery, first buy record, tp1-marker sells), then compute all open sim
 * cycles in one sorted walk instead of re-scanning records per position.
 */
function openPositionsFor(records: Records, strategyId: string): OpenPosition[] {
  const candidateMints = new Set<string>()
  const candidateOrder: string[] = []
  const candidateToken = new Map<string, { symbol?: string }>()
  const buyByMint = new Map<string, Records[number]>()
  const tp1Mints = new Set<string>()

  for (const r of records) {
    const isCandidate = r.is_simulation === true && r.bot_strategy === strategyId
    const isBuy = r.operationType === 'buy' && r.bot_strategy === strategyId
    const isTp1Sell =
      r.operationType === 'sell' &&
      r.bot_strategy === strategyId &&
      !r.close_position
    if (!isCandidate && !isBuy && !isTp1Sell) continue

    for (const t of r.tokens ?? []) {
      const mint = t.mintAddress
      if (isCandidate && !candidateMints.has(mint)) {
        candidateMints.add(mint)
        candidateOrder.push(mint)
        candidateToken.set(mint, t)
      }
      if (isBuy && !buyByMint.has(mint)) buyByMint.set(mint, r)
      if (isTp1Sell) tp1Mints.add(mint)
    }
  }

  const cycles = computeOpenSimCycles(records, candidateMints)
  const open: OpenPosition[] = []

  for (const mint of candidateOrder) {
    const cycle = cycles.get(mint)
    if (!cycle || cycle.simulationType !== 'strategy') continue

    const buy = buyByMint.get(mint)
    const sim = (buy?.trading_simulation ?? {}) as Record<string, unknown>
    const t = candidateToken.get(mint)

    open.push({
      mintAddress: mint,
      symbol: t?.symbol ?? mint.slice(0, 8),
      entryAt: typeof sim.entry_at === 'string' ? sim.entry_at : null,
      entryPriceUsd:
        typeof sim.entry_price_usd === 'number' && sim.entry_price_usd > 0
          ? sim.entry_price_usd
          : cycle.weightedBuyPriceUsd,
      tp1Done: tp1Mints.has(mint),
      entryFeatures:
        sim.entry_features && typeof sim.entry_features === 'object'
          ? (sim.entry_features as Record<string, unknown>)
          : {},
      cycle,
    })
  }

  return open
}

function passesConditions(
  strategy: TrendingBotStrategy,
  token: { mcap: number; organic_score: number },
): boolean {
  const c = strategy.conditions
  if (!c) return true
  if (c.min_market_cap != null && token.mcap < c.min_market_cap) return false
  if (c.max_market_cap != null && token.mcap > c.max_market_cap) return false
  if (c.min_organic_score != null && token.organic_score < c.min_organic_score) {
    return false
  }
  return true
}

async function sellSim(params: {
  strategyId: string
  position: OpenPosition
  sellPriceUsd: number
  fraction: number
  reason: string
  closePosition: boolean
}): Promise<void> {
  // Reuse the cycle computed during single-pass position reconstruction.
  const cycle = params.position.cycle

  const nativeUsd = await getNativeUsd(CHAIN)
  const tokenAmount = params.closePosition
    ? cycle.remainingTokenAmount
    : cycle.remainingTokenAmount * params.fraction
  const nativeReceived =
    params.sellPriceUsd > 0 && nativeUsd > 0
      ? (tokenAmount * params.sellPriceUsd) / nativeUsd
      : cycle.totalSolBought * params.fraction

  const pnlPct =
    cycle.weightedBuyPriceUsd > 0
      ? ((params.sellPriceUsd - cycle.weightedBuyPriceUsd) /
          cycle.weightedBuyPriceUsd) *
        100
      : 0

  await insertTradingRecord(
    buildTradingRecord({
      walletAddress: SIM_WALLET,
      chain: CHAIN,
      operationType: 'sell',
      is_simulation: true,
      simulation_type: 'strategy',
      bot_strategy: params.strategyId,
      close_position: params.closePosition,
      tokens: [
        {
          mintAddress: params.position.mintAddress,
          symbol: params.position.symbol,
          tokenAmount,
          solAmount: nativeReceived,
          priceUsd: params.sellPriceUsd,
          solPrice: nativeUsd,
        },
      ],
      successCount: 1,
      failureCount: 0,
      totalTokens: 1,
      solAmount: nativeReceived,
      feesPaid: 0,
      solPriceUsd: nativeUsd,
      signatures: [`trending-rh-sim-sell-${Date.now()}`],
      status: pnlPct >= 0 ? 'won' : 'lost',
      trading_simulation: { close_reason: params.reason },
    }),
  )

  // Partial take-profit keeps the position open; outcomes land on full close only.
  if (!params.closePosition) return

  await recordTrendingBotOutcome({
    strategyId: params.strategyId,
    chain: CHAIN,
    tokenAddress: params.position.mintAddress,
    entryAt: params.position.entryAt,
    exitAt: new Date().toISOString(),
    pnlPct,
    status: pnlPct >= 0 ? 'won' : 'lost',
    isSimulated: true,
    features: {
      ...params.position.entryFeatures,
      token_symbol: params.position.symbol,
      exit_price_usd: params.sellPriceUsd,
      close_reason: params.reason,
      sol_spent: cycle.totalSolBought,
      sol_received: nativeReceived,
    },
  })
}

async function buySim(params: {
  strategy: TrendingBotStrategy
  token: {
    token_address: string
    token_symbol: string
    price: number
    mcap: number
    organic_score: number
    change_5m: number
    change_1h: number
  }
}): Promise<void> {
  const { strategy, token } = params
  const nativeAmount = strategy.buy_amount_native ?? strategy.buy_amount_sol
  const nativeUsd = await getNativeUsd(CHAIN)
  const priceUsd = token.price > 0 ? token.price : 0.000001
  const tokenAmount = nativeUsd > 0 ? (nativeAmount * nativeUsd) / priceUsd : 0
  const entryAt = new Date().toISOString()

  const entryFeatures = {
    entry_at: entryAt,
    entry_mcap: token.mcap,
    initial_price_usd: priceUsd,
    token_symbol: token.token_symbol,
    organic_score: token.organic_score,
    price_change_5m: token.change_5m,
    price_change_1h: token.change_1h,
    chain: CHAIN,
    strategy_id: strategy.id,
    domain: 'trending_bot',
  }

  await insertTradingRecord(
    buildTradingRecord({
      walletAddress: SIM_WALLET,
      chain: CHAIN,
      operationType: 'buy',
      is_simulation: true,
      simulation_type: 'strategy',
      bot_strategy: strategy.id,
      tokens: [
        {
          mintAddress: token.token_address,
          symbol: token.token_symbol,
          tokenAmount,
          solAmount: nativeAmount,
          priceUsd,
          solPrice: nativeUsd,
        },
      ],
      successCount: 1,
      failureCount: 0,
      totalTokens: 1,
      solAmount: nativeAmount,
      feesPaid: 0,
      solPriceUsd: nativeUsd,
      totalUsdValue: nativeUsd ? nativeAmount * nativeUsd : undefined,
      signatures: [`trending-rh-sim-buy-${Date.now()}`],
      status: 'tracking',
      trading_simulation: {
        entry_at: entryAt,
        entry_price_usd: priceUsd,
        entry_features: entryFeatures,
      },
    }),
  )
}

export async function runTrendingBotRhSimCycle(): Promise<RhTrendingSimResult[]> {
  const { strategies, configs } = await getActiveStrategiesWithState(CHAIN)
  if (strategies.length === 0) return []

  const { tokens } = await getFilteredGmgnTrending(CHAIN)
  const records = await fetchTradingRecordsForWallet(SIM_WALLET)
  const results: RhTrendingSimResult[] = []

  for (const strategyId of strategies) {
    const strategy = configs[strategyId]
    if (!strategy) continue

    const open = openPositionsFor(records, strategyId)
    const openMints = new Set(open.map((p) => p.mintAddress))
    const skipped: string[] = []
    let opened = 0
    let closed = 0

    const marks =
      open.length > 0
        ? await getOpenPositionPrices(
            open.map((p) => p.mintAddress),
            CHAIN,
          )
        : {}

    for (const pos of open) {
      const price = marks[pos.mintAddress] ?? pos.entryPriceUsd
      if (!(price > 0) || !(pos.entryPriceUsd > 0)) continue
      const gainPct = ((price - pos.entryPriceUsd) / pos.entryPriceUsd) * 100
      const heldHours = pos.entryAt
        ? (Date.now() - new Date(pos.entryAt).getTime()) / 3_600_000
        : 0

      const decision = decideRhTrendingExit({
        strategy,
        gainPct,
        heldHours,
        tp1Done: pos.tp1Done,
      })
      if (decision.action === 'hold') continue

      await sellSim({
        strategyId,
        position: pos,
        sellPriceUsd: price,
        fraction:
          decision.action === 'partial' ? decision.sellPct / 100 : 1,
        reason: decision.reason,
        closePosition: decision.action === 'close',
      })

      if (decision.action === 'close') {
        closed++
        openMints.delete(pos.mintAddress)
      }
    }

    const candidates = tokens.filter((t) => passesConditions(strategy, t))
    const maxOpenPositions =
      strategy.max_open_positions ?? RH_MAX_OPEN_POSITIONS_DEFAULT
    for (const token of candidates) {
      if (openMints.has(token.token_address)) continue
      if (openMints.size >= maxOpenPositions) {
        skipped.push(`${token.token_symbol}: max positions`)
        break
      }
      await buySim({ strategy, token })
      openMints.add(token.token_address)
      opened++
    }

    results.push({
      strategyId,
      chain: CHAIN,
      candidates: candidates.length,
      opened,
      closed,
      skipped,
    })
  }

  log.info('api_request', 'Robinhood trending sim cycle', { results })
  return results
}
