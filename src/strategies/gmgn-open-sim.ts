import { buildFullEntryFeatureSnapshot } from '@/strategies/resolve-entry-snapshot'
import type { GmgnStrategy } from '@/strategies/types'
import { getSolPriceUSD } from '@/utils/solana'
import { buildTradingRecord, insertTradingRecord } from '@/utils/trading-records-db'

export const GMGN_SIM_WALLET =
  process.env.GMGN_SIM_WALLET_ADDRESS || 'gmgn-sim'

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function gmgnTopHoldersToPct(rate: number | null): number | null {
  if (rate == null) return null
  if (rate >= 0 && rate <= 1) return rate * 100
  return rate
}

export async function openGmgnSimPosition(params: {
  strategy: GmgnStrategy
  mintAddress: string
  symbol: string
  entryFeatures: Record<string, unknown>
  entryPriceUsd: number
}): Promise<void> {
  const solAmount = params.strategy.config.execution.simBuySol
  const solPrice = await getSolPriceUSD()
  const priceUsd = params.entryPriceUsd > 0 ? params.entryPriceUsd : 0.000001
  const tokenAmount =
    priceUsd > 0 && solPrice > 0 ? (solAmount * solPrice) / priceUsd : solAmount * 1_000_000

  const entryAt = new Date().toISOString()
  const entryMcap = readFiniteNumber(params.entryFeatures.gmgn_market_cap_usd)
  const topHoldersPct = gmgnTopHoldersToPct(
    readFiniteNumber(params.entryFeatures.gmgn_top_10_holder_rate),
  )

  const fullFeatures = await buildFullEntryFeatureSnapshot(
    params.mintAddress,
    {
      entryAt,
      entryMcap,
      topHoldersPct,
      tokenSymbol: params.symbol,
    },
    params.entryFeatures,
  )

  const record = buildTradingRecord({
    walletAddress: GMGN_SIM_WALLET,
    operationType: 'buy',
    is_simulation: true,
    simulation_type: 'strategy',
    bot_strategy: params.strategy.id,
    tokens: [
      {
        mintAddress: params.mintAddress,
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
    signatures: [`gmgn-sim-open-${Date.now()}`],
    status: 'tracking',
    trading_simulation: {
      entry_at: entryAt,
      entry_price_usd: priceUsd,
      entry_features: {
        ...fullFeatures,
        entry_at: entryAt,
        initial_price_usd: priceUsd,
        token_symbol: params.symbol,
      },
    },
  })

  await insertTradingRecord(record)

  const { notifyStrategyOpen } = await import('@/strategies/strategy-telegram-notify')
  notifyStrategyOpen({
    domain: 'gmgn',
    strategyId: params.strategy.id,
    tokenSymbol: params.symbol,
    tokenAddress: params.mintAddress,
    marketCap: entryMcap,
    isSimulated: true,
    topHoldersPct,
    features: fullFeatures,
  })
}
