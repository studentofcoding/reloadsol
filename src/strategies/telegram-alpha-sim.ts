import { buildTradingRecord, insertTradingRecord } from '@/utils/trading-records-db'
import { getNativeUsd } from '@/utils/native-usd'
import { SIGNALS_SIM_WALLET, simWalletForChain } from '@/strategies/sim-wallets'
import type { StrategyChain } from '@/strategies/types'

export { SIGNALS_SIM_WALLET }

export async function openSignalsSimPosition(params: {
  strategyId: string
  chain?: StrategyChain
  mintAddress: string
  symbol: string
  solAmount: number
  priceUsd: number
  entryFeatures: Record<string, unknown>
}): Promise<void> {
  const chain = params.chain ?? 'sol'
  // solAmount / solPrice are native-token denominated; that's ETH on robinhood.
  const solPrice = await getNativeUsd(chain)
  const tokenAmount =
    params.priceUsd > 0 && solPrice > 0
      ? (params.solAmount * solPrice) / params.priceUsd
      : params.solAmount * 1000

  const record = buildTradingRecord({
    walletAddress: simWalletForChain(SIGNALS_SIM_WALLET, chain),
    chain,
    operationType: 'buy',
    is_simulation: true,
    simulation_type: 'strategy',
    bot_strategy: params.strategyId,
    tokens: [
      {
        mintAddress: params.mintAddress,
        symbol: params.symbol,
        tokenAmount,
        solAmount: params.solAmount,
        priceUsd: params.priceUsd,
        solPrice,
      },
    ],
    successCount: 1,
    failureCount: 0,
    totalTokens: 1,
    solAmount: params.solAmount,
    feesPaid: 0,
    solPriceUsd: solPrice,
    totalUsdValue: solPrice ? params.solAmount * solPrice : undefined,
    signatures: [`signals-sim-${Date.now()}`],
    status: 'tracking',
    trading_simulation: {
      strategy_id: params.strategyId,
      entry_at: new Date().toISOString(),
      entry_features: params.entryFeatures,
    },
  })

  await insertTradingRecord(record)

  const entryMcap =
    typeof params.entryFeatures.entry_mcap === 'number'
      ? params.entryFeatures.entry_mcap
      : typeof params.entryFeatures.first_mcap === 'number'
        ? params.entryFeatures.first_mcap
        : null
  const { notifyStrategyOpen } = await import('@/strategies/strategy-telegram-notify')
  notifyStrategyOpen({
    domain: 'signals',
    strategyId: params.strategyId,
    tokenSymbol: params.symbol,
    tokenAddress: params.mintAddress,
    marketCap: entryMcap,
    isSimulated: true,
  })
}
