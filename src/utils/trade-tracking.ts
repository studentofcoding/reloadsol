import type { TrackingRecord } from '@/utils/trading-tracker'
import { getSolPriceUSD } from '@/utils/solana'
import { fetchTokenPricesForTracking } from '@/utils/trading-tracker'
import {
  closeSimulationPosition,
  type CloseSimulationParams,
} from '@/utils/simulation-trades'

type TrackFn = (
  operation: Omit<TrackingRecord, 'id' | 'timestamp'>,
) => Promise<void>

export interface RealTradeToken {
  mintAddress: string
  symbol?: string
  name?: string
  logoURI?: string
  tokenAmount?: number
  solAmount?: number
  priceUsd?: number
}

export interface RealTradeMeta {
  walletAddress: string
  tokens: RealTradeToken[]
  signatures: string[]
  solAmount: number
  feesPaid?: number
  slippage?: number
  priorityFee?: number
  is_bot_operation?: boolean
  bot_strategy?: string
  jupiter_swap?: boolean
  swap_route?: string
}

async function baseRealFields(meta: RealTradeMeta) {
  const solPrice = await getSolPriceUSD()
  const mints = meta.tokens.map((t) => t.mintAddress).filter(Boolean)
  const prices =
    mints.length > 0 ? await fetchTokenPricesForTracking(mints) : {}

  const tokens = meta.tokens.map((t) => ({
    ...t,
    solPrice,
    priceUsd: t.priceUsd ?? prices[t.mintAddress],
    solAmount: t.solAmount,
  }))

  return {
    walletAddress: meta.walletAddress,
    tokens,
    successCount: meta.tokens.length,
    failureCount: 0,
    totalTokens: meta.tokens.length,
    solAmount: meta.solAmount,
    feesPaid: meta.feesPaid ?? 0,
    solPriceUsd: solPrice,
    totalUsdValue: solPrice ? meta.solAmount * solPrice : undefined,
    signatures: meta.signatures,
    slippage: meta.slippage,
    priorityFee: meta.priorityFee,
    is_bot_operation: meta.is_bot_operation,
    bot_strategy: meta.bot_strategy,
    jupiter_swap: meta.jupiter_swap,
    swap_route: meta.swap_route,
    is_simulation: false as const,
  }
}

export async function trackRealBuy(
  trackOperation: TrackFn,
  meta: RealTradeMeta,
): Promise<void> {
  await trackOperation({
    ...(await baseRealFields(meta)),
    operationType: 'buy',
  })
}

export async function trackRealSell(
  trackOperation: TrackFn,
  meta: RealTradeMeta,
): Promise<void> {
  await trackOperation({
    ...(await baseRealFields(meta)),
    operationType: 'sell',
  })
}

export async function trackRealClose(
  trackOperation: TrackFn,
  meta: RealTradeMeta,
): Promise<void> {
  await trackOperation({
    ...(await baseRealFields(meta)),
    operationType: 'close',
  })
}

export interface SimBuyMeta {
  walletAddress: string
  mintAddress: string
  symbol?: string
  name?: string
  logoURI?: string
  solAmount: number
  tokenAmount: number
  priceUsd?: number
  botStrategy?: string
  simulationType?: 'manual' | 'strategy'
  entryFeatures?: Record<string, unknown>
}

export async function trackSimBuy(
  trackOperation: TrackFn,
  meta: SimBuyMeta,
): Promise<void> {
  const solPrice = await getSolPriceUSD()
  let priceUsd = meta.priceUsd
  if (!priceUsd && meta.tokenAmount > 0) {
    priceUsd = (meta.solAmount * solPrice) / meta.tokenAmount
  }

  const entryAt = new Date().toISOString()
  const tradingSimulation =
    meta.botStrategy || meta.entryFeatures
      ? {
          strategy_id: meta.botStrategy,
          entry_at: entryAt,
          entry_features: meta.entryFeatures ?? {},
        }
      : undefined

  await trackOperation({
    walletAddress: meta.walletAddress,
    operationType: 'buy',
    is_simulation: true,
    simulation_type: meta.simulationType ?? 'manual',
    bot_strategy: meta.botStrategy,
    trading_simulation: tradingSimulation,
    tokens: [
      {
        mintAddress: meta.mintAddress,
        symbol: meta.symbol,
        name: meta.name,
        logoURI: meta.logoURI,
        tokenAmount: meta.tokenAmount,
        solAmount: meta.solAmount,
        priceUsd,
        solPrice,
      },
    ],
    successCount: 1,
    failureCount: 0,
    totalTokens: 1,
    solAmount: meta.solAmount,
    feesPaid: 0,
    solPriceUsd: solPrice,
    totalUsdValue: solPrice ? meta.solAmount * solPrice : undefined,
    signatures: [`sim-${Date.now()}`],
    status: 'tracking',
  })
}

export async function trackSimClose(
  params: CloseSimulationParams,
): Promise<{ solReceived: number }> {
  return closeSimulationPosition(params)
}
