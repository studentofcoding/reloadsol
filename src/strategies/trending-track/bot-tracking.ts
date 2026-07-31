// Bot operation tracking extracted from src/app/api/trending/track/route.ts (REL-19).
import { tradingKeypair } from './state'
import { getBuyAmountForStrategy } from './strategy-params'
import type { TradeExecutionResult } from './types'

export async function trackBotOperation(
  operationType: 'buy' | 'sell',
  token: any,
  bestResult: TradeExecutionResult,
  isSimulated: boolean,
  strategy: string = 'auto-trending',
  tokenDecimals: number = 6,
): Promise<void> {
  try {
    const { getSolPriceUSD } = await import('@/utils/solana')
    const {
      buildTradingRecord,
      insertTradingRecord,
    } = await import('@/utils/trading-records-db')

    const currentSolPrice = await getSolPriceUSD()
    const walletAddress = tradingKeypair?.publicKey.toString() || 'simulation'
    const decimals = tokenDecimals >= 0 ? tokenDecimals : 6

    const solAmount =
      operationType === 'buy'
        ? bestResult.inputAmount
          ? parseFloat(bestResult.inputAmount) / 1e9
          : getBuyAmountForStrategy(strategy)
        : parseFloat(bestResult.outputAmount) / 1e9

    const tokenAmount =
      operationType === 'buy'
        ? parseFloat(bestResult.outputAmount) / Math.pow(10, decimals)
        : parseFloat(bestResult.inputAmount) / Math.pow(10, decimals)

    const tokenData = {
      mintAddress: token.token_address,
      symbol: token.token_symbol,
      name: token.token_name,
      logoURI: token.logo_url,
      priceUsd: token.current_price || token.last_price_usd,
      tokenAmount: Number.isFinite(tokenAmount) ? tokenAmount : 0,
      solAmount,
      solPrice: currentSolPrice,
    }

    const record = buildTradingRecord({
      walletAddress,
      operationType,
      tokens: [tokenData],
      successCount: 1,
      failureCount: 0,
      totalTokens: 1,
      solAmount,
      feesPaid: bestResult.fees?.totalFees || 0,
      solPriceUsd: currentSolPrice,
      totalUsdValue: currentSolPrice ? solAmount * currentSolPrice : undefined,
      signatures: bestResult.signature ? [bestResult.signature] : [],
      slippage: 3,
      priorityFee: 100000,
      errors: undefined,
      is_bot_operation: true,
      bot_strategy: strategy,
      is_simulation: isSimulated,
      simulation_type: isSimulated ? 'strategy' : undefined,
      close_position: operationType === 'sell' && isSimulated ? true : undefined,
    })

    await insertTradingRecord(record)

    console.log(`🤖 Bot operation tracked: ${operationType} ${token.token_symbol} (${strategy}, sim=${isSimulated})`)

    await triggerPnLSync(walletAddress)
  } catch (error) {
    console.error(`❌ Failed to track bot operation:`, error)
  }
}

// ✅ NEW: Function to trigger PnL synchronization
export async function triggerPnLSync(walletAddress: string): Promise<void> {
  try {
    // Trigger a webhook or event to notify the UI about new bot operations
    // This could be a simple HTTP call to invalidate caches
    await fetch('/api/trading/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress,
        timestamp: Date.now(),
        source: 'bot_operation'
      })
    }).catch(() => {
      // Ignore sync errors - this is best effort
      console.log('📡 PnL sync notification sent (best effort)')
    })
  } catch (error) {
    // Silent fail - sync is best effort
  }
}
