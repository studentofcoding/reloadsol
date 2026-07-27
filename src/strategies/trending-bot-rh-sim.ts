/**
 * Robinhood twin of the trending_bot cycle: paper-only, GMGN market rank as the
 * candidate source, ETH-denominated sizing. The Solana cycle in
 * /api/trending/track keeps its Jupiter list, tracker table and live wallet —
 * none of that exists on robinhood, so RH runs on trading_records alone.
 */

import { fetchTradingRecordsForWallet } from './db'
import { getActiveStrategiesWithState } from './load-strategy'
import { recordTrendingBotOutcome } from './outcomes'
import { simWalletForChain, TRENDING_BOT_SIM_WALLET } from './sim-wallets'
import type { TrendingBotStrategy } from './types'
import { getFilteredGmgnTrending } from '@/utils/gmgn-trending-feed'
import { getNativeUsd } from '@/utils/native-usd'
import { getOpenPositionPrices } from '@/utils/open-position-prices'
import { computeOpenSimCycle } from '@/utils/simulation-trades'
import { buildTradingRecord, insertTradingRecord } from '@/utils/trading-records-db'
import { log } from '@/utils/unified-logger'

const CHAIN = 'robinhood' as const

// ponytail: flat cap instead of a per-strategy field — the Solana cycle bounds
// itself with live balance checks that have no RH equivalent. Upgrade path:
// max_open_positions on TrendingBotStrategy once RH sizing gets a budget.
const MAX_OPEN_POSITIONS = 10

const SIM_WALLET = simWalletForChain(TRENDING_BOT_SIM_WALLET, CHAIN)

type OpenPosition = {
  mintAddress: string
  symbol: string
  entryAt: string | null
  entryPriceUsd: number
  tp1Done: boolean
  entryFeatures: Record<string, unknown>
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

function openPositionsFor(records: Records, strategyId: string): OpenPosition[] {
  const seen = new Set<string>()
  const open: OpenPosition[] = []

  for (const r of records) {
    if (!r.is_simulation || r.bot_strategy !== strategyId) continue
    for (const t of r.tokens ?? []) {
      if (seen.has(t.mintAddress)) continue
      const cycle = computeOpenSimCycle(records, t.mintAddress)
      if (!cycle || cycle.simulationType !== 'strategy') continue
      seen.add(t.mintAddress)

      const buy = records.find(
        (rec) =>
          rec.operationType === 'buy' &&
          rec.bot_strategy === strategyId &&
          rec.tokens?.some((tk) => tk.mintAddress === t.mintAddress),
      )
      const sim = (buy?.trading_simulation ?? {}) as Record<string, unknown>
      const tp1Done = records.some(
        (rec) =>
          rec.operationType === 'sell' &&
          rec.bot_strategy === strategyId &&
          !rec.close_position &&
          rec.tokens?.some((tk) => tk.mintAddress === t.mintAddress),
      )

      open.push({
        mintAddress: t.mintAddress,
        symbol: t.symbol ?? t.mintAddress.slice(0, 8),
        entryAt: typeof sim.entry_at === 'string' ? sim.entry_at : null,
        entryPriceUsd:
          typeof sim.entry_price_usd === 'number' && sim.entry_price_usd > 0
            ? sim.entry_price_usd
            : cycle.weightedBuyPriceUsd,
        tp1Done,
        entryFeatures:
          sim.entry_features && typeof sim.entry_features === 'object'
            ? (sim.entry_features as Record<string, unknown>)
            : {},
      })
    }
  }

  return open
}

type ExitDecision =
  | { action: 'hold' }
  | { action: 'partial'; sellPct: number; reason: string }
  | { action: 'close'; reason: string }

/** Same ladder the Solana bot uses: TP1 partial, TP2/TP3 full, SL, max hold. */
export function decideRhTrendingExit(params: {
  strategy: TrendingBotStrategy
  gainPct: number
  heldHours: number
  tp1Done: boolean
}): ExitDecision {
  const { strategy, gainPct, heldHours, tp1Done } = params
  const tp = strategy.take_profit_levels

  if (gainPct <= strategy.stop_loss_percentage) {
    return { action: 'close', reason: 'stop_loss' }
  }
  if (tp.tp3_enabled && gainPct >= tp.tp3_percentage) {
    return { action: 'close', reason: 'tp3' }
  }
  if (gainPct >= tp.tp2_percentage) {
    return { action: 'close', reason: 'tp2' }
  }
  if (!tp1Done && gainPct >= tp.tp1_percentage) {
    return tp.tp1_sell_percentage >= 100
      ? { action: 'close', reason: 'tp1' }
      : { action: 'partial', sellPct: tp.tp1_sell_percentage, reason: 'tp1' }
  }
  if (strategy.max_hold_hours > 0 && heldHours >= strategy.max_hold_hours) {
    return { action: 'close', reason: 'max_hold' }
  }
  return { action: 'hold' }
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
  records: Records
  sellPriceUsd: number
  fraction: number
  reason: string
  closePosition: boolean
}): Promise<void> {
  const cycle = computeOpenSimCycle(params.records, params.position.mintAddress)
  if (!cycle) return

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
        records,
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
    for (const token of candidates) {
      if (openMints.has(token.token_address)) continue
      if (openMints.size >= MAX_OPEN_POSITIONS) {
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
