// Buy/sell execution + exit decision extracted from src/app/api/trending/track/route.ts (REL-19).
import { notifyTradingUpdate } from '@/utils/trading-notifications'
import { assessTokenRisk } from '@/utils/risk-assessment'
import { fetchTokenMetadataFromJupiter } from '@/utils/jupiter-metadata'
import { calculateGainPercentage } from '@/utils/trading-math'
import { logTradeOperation } from '@/utils/unified-logger'
import { shouldEnableNotifications, sendBuyNotificationDiscord } from '@/utils/discord'
import { getCurrentBotStrategySync, resolveTradingStrategy } from '@/strategies/load-strategy'
import { decideTrendingExit } from '@/strategies/exit-ladder'
import {
  activeTrades,
  activeTradesByStrategy,
  tradingConnection,
  tradingKeypair,
  tradingSigner,
  initializeTradingConnection,
  initializeTradingKeypair,
} from './state'
import { checkRpcHealth, canExecuteRealTradeWithStrategy } from './wallet'
import { createTradeExecutor, createSynchronizedTradeExecutor, SimulationExecutor } from './executors'
import { getBuyAmountForStrategy, getPriorityFeeForStrategy } from './strategy-params'
import { trackBotOperation } from './bot-tracking'
import { sendSignificantDeviationsAlertDiscord } from './discord'
import type {
  TrackedToken,
  TradingSimulation,
  BuyOperation,
  SellOperation,
  TradeExecutionResult,
  SyncedTradeResult,
} from './types'

export async function executeBuyOperationWithStrategy(
  token: any,
  strategyId: string,
  operationType: 'simulation' | 'real' = 'simulation',
  simulation: TradingSimulation
): Promise<BuyOperation | null> {
  const strategy = resolveTradingStrategy(strategyId)
  console.log(`🎯 Executing buy operation for ${token.token_symbol} using ${strategy.name} strategy`)
  const isSimulated = operationType === 'simulation'
  let tradeLockHeld = false

  try {
    if (!isSimulated) {
      const { acquireTradeLock } = await import('@/utils/bot-trading-state')
      const dbLock = await acquireTradeLock(token.token_address, strategyId)
      if (!dbLock.acquired) {
        console.error(`❌ Cannot execute real trade for ${token.token_symbol}: ${dbLock.reason}`)
        return null
      }
      tradeLockHeld = true
    }

    console.log(`💰 Performing synchronized buy ${operationType} for ${token.token_symbol} (${token.token_address})`)

    // SOL mint address and trading parameters
    const SOL_MINT = 'So11111111111111111111111111111111111111112'
    let BUY_AMOUNT_SOL = getBuyAmountForStrategy(strategyId) // Dynamic based on strategy
    let PRIORITY_FEE_LAMPORTS = getPriorityFeeForStrategy(strategyId)

    let isRebuy = false

    // Check if this is a real trade and if we need to adjust the buy amount for re-buy
    if (!isSimulated) {
      const tradeCheck = await canExecuteRealTradeWithStrategy(BUY_AMOUNT_SOL, strategyId, token.token_address, token.token_symbol, token.current_price)

      if (!tradeCheck.canTrade) {
        console.error(`❌ Cannot execute real trade for ${token.token_symbol}: ${tradeCheck.reason}`)
        return null
      }

      // Use adjusted buy amount if this is a re-buy
      if (tradeCheck.adjustedBuyAmount && tradeCheck.adjustedBuyAmount !== BUY_AMOUNT_SOL) {
        BUY_AMOUNT_SOL = tradeCheck.adjustedBuyAmount
        isRebuy = tradeCheck.isRebuy || false
        console.log(`🔄 Using adjusted buy amount for ${token.token_symbol}: ${BUY_AMOUNT_SOL} SOL ${isRebuy ? '(re-buy)' : ''}`)
      }

      // Mark token as having active trade for this strategy
      const strategyActiveTrades = activeTradesByStrategy.get(strategyId) || new Set()
      strategyActiveTrades.add(token.token_address)
      activeTradesByStrategy.set(strategyId, strategyActiveTrades)
    }

    const BUY_AMOUNT_LAMPORTS = Math.floor(BUY_AMOUNT_SOL * 1e9)

    // Safety checks for real trading
    if (!isSimulated) {
      // Add diagnostic logging
      console.log(`🔧 Real trade safety check for ${token.token_symbol}:`)
      console.log(`  - simulation.keypair_path: ${simulation.keypair_path || 'undefined'}`)
      console.log(`  - TRADING_KEYPAIR_JSON env var: ${process.env.TRADING_KEYPAIR_JSON ? 'SET' : 'NOT SET'}`)
      console.log(`  - Global tradingKeypair: ${tradingKeypair ? 'initialized' : 'null'}`)

      // Enhanced keypair validation - check both simulation path and environment variable
      const hasKeypairPath = !!simulation.keypair_path
      const hasEnvKeypair = !!process.env.TRADING_KEYPAIR_JSON

      if (!hasKeypairPath && !hasEnvKeypair) {
        throw new Error('Trading keypair not configured (set TRADING_KEYPAIR_JSON or provide keypair_path)')
      }

      // Check RPC health before trading
      const rpcHealth = await checkRpcHealth()
      if (!rpcHealth.healthy) {
        throw new Error(`Shyft RPC unhealthy: ${rpcHealth.error}`)
      }

      // Initialize trading infrastructure
      const connection = initializeTradingConnection()
      await initializeTradingKeypair(simulation.keypair_path)

      // Safety checks already performed above, just mark as active trade
      console.log(`🔥 Real trading safety checks passed - proceeding with ${BUY_AMOUNT_SOL} SOL buy`)

      // Mark token as having active trade
      activeTrades.add(token.token_address)

      console.log(`🔥 Real trading safety checks passed - RPC healthy (${rpcHealth.latency}ms), sufficient balance${isRebuy ? ' (re-buy scenario)' : ''}`)
    }

    // Create synchronized executor
    const syncExecutor = createSynchronizedTradeExecutor(
      isSimulated ? undefined : tradingConnection!,
      isSimulated ? undefined : tradingSigner!
    )

    // Test different slippage configurations with synchronization
    const slippageConfigs = [
      { key: 'slippage_3', bps: 300 }    // 3% - required for real trades
    ]

    const configurations: any = {}
    const allResults: TradeExecutionResult[] = []
    const syncResults: SyncedTradeResult[] = []

    // For real trading, use 3% slippage for execution but test all for comparison
    const configsToTest = slippageConfigs
    const realTradeSlippage = 300 // 3% slippage for real trades

    for (const config of configsToTest) {
      try {
        console.log(`  📊 Testing ${config.key} (${config.bps} bps slippage) with synchronization...`)

        // Execute synchronized trade
        const shouldExecuteReal = !isSimulated && config.bps === realTradeSlippage
        const syncResult = await syncExecutor.executeSyncedBuy({
          tokenAddress: token.token_address,
          tokenSymbol: token.token_symbol,
          inputMint: SOL_MINT,
          outputMint: token.token_address,
          amount: BUY_AMOUNT_LAMPORTS,
          slippageBps: config.bps,
          userPublicKey: isSimulated ? '11111111111111111111111111111111' : tradingKeypair!.publicKey.toBase58(),
          priorityFee: shouldExecuteReal ? PRIORITY_FEE_LAMPORTS : 0,
          strategy: strategyId,
          tokenData: token
        }, shouldExecuteReal)

        syncResults.push(syncResult)

        // Use the appropriate result (real if available, otherwise simulation)
        const result = syncResult.real || syncResult.simulation

        configurations[config.key] = {
          success: result.success,
          response_time: result.responseTime,
          token_amount: result.outputAmount,
          total_fees: result.fees.totalFees,
          price_impact: '0', // Will be calculated from quote
          best_provider: result.provider,
          rpc_used: result.rpcUsed,
          signature: result.signature,
          error: result.error,
          // Add synchronization data
          sync_data: syncResult.deviation ? {
            output_deviation_percent: syncResult.deviation.outputAmountDiffPercent,
            fees_diff: syncResult.deviation.feesDiff,
            response_time_diff: syncResult.deviation.responseTimeDiff
          } : undefined
        }

        if (result.success) {
          allResults.push(result)
          console.log(`    ✅ ${config.key}: ${result.provider} - ${result.outputAmount} tokens, ${result.responseTime}ms${result.signature ? ` (${result.signature.slice(0, 8)}...)` : ''}`)

          // Log synchronization results
          if (syncResult.deviation) {
            console.log(`    📊 Sync deviation: ${syncResult.deviation.outputAmountDiffPercent.toFixed(2)}% output, ${syncResult.deviation.feesDiff.toFixed(6)} SOL fees`)
          }
        } else {
          console.log(`    ❌ ${config.key}: ${result.error}`)
        }

        // For real trading, break loop once the live 3% trade succeeded
        if (!isSimulated && result.success && shouldExecuteReal) {
          break
        }

      } catch (error) {
        console.error(`    ❌ ${config.key} error:`, error)
        configurations[config.key] = {
          success: false,
          response_time: 0,
          token_amount: '0',
          total_fees: 0,
          price_impact: '0',
          best_provider: 'none',
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }

      // Small delay between configurations (simulation only)
      if (isSimulated) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    // Log synchronization summary
    const significantDeviations = syncResults.filter(r =>
      r.deviation && r.deviation.outputAmountDiffPercent > 2
    )

    if (significantDeviations.length > 0) {
      console.warn(`⚠️ Found ${significantDeviations.length} significant deviations (>2%) for ${token.token_symbol}`)

      // Send Discord alert for significant deviations
      if (shouldEnableNotifications()) {
        try {
          await sendSignificantDeviationsAlertDiscord({
            tokenSymbol: token.token_symbol,
            tokenAddress: token.token_address,
            deviations: significantDeviations,
            operationType: 'buy'
          })
        } catch (discordError) {
          console.error('❌ Failed to send significant deviations Discord alert:', discordError)
          // Don't fail the operation if Discord notification fails
        }
      }
    } else {
      console.log(`✅ All synchronization results within acceptable range for ${token.token_symbol}`)
    }

    // Find best result (considering both amount and fees for real trades)
    const bestResult = allResults.reduce((best, current) => {
      if (!best) return current

      const bestAmount = parseFloat(best.outputAmount)
      const currentAmount = parseFloat(current.outputAmount)

      // For real trades, also consider fees and slippage
      if (!isSimulated) {
        const bestValue = bestAmount - best.fees.totalFees
        const currentValue = currentAmount - current.fees.totalFees
        return currentValue > bestValue ? current : best
      }

      // For simulation, just compare token amounts
      return currentAmount > bestAmount ? current : best
    }, allResults[0])

    if (!bestResult) {
      console.log(`❌ No successful buy ${operationType} for ${token.token_symbol}`)
      return null
    }

    // Position validation for real trades
    if (!isSimulated && bestResult.success) {
      const tokenAmount = parseFloat(bestResult.outputAmount)
      const expectedMinTokens = BUY_AMOUNT_SOL * 0.8 / token.current_price // At least 80% of expected

      if (tokenAmount < expectedMinTokens) {
        console.warn(`⚠️ Real trade token amount lower than expected: ${tokenAmount} < ${expectedMinTokens}`)
      } else {
        console.log(`✅ Real trade position validated: ${tokenAmount} tokens received`)
      }
    }

    const buyOperation: BuyOperation = {
      timestamp: new Date().toISOString(),
      buy_amount_sol: BUY_AMOUNT_SOL,
      token_amount_received: bestResult.outputAmount,
      buy_price_usd: token.current_price,
      configurations,
      best_buy_config: {
        slippage: 1, // Will be determined from best result
        provider: bestResult.provider,
        token_amount: bestResult.outputAmount,
        response_time: bestResult.responseTime,
        total_fees: bestResult.fees.totalFees,
        rpc_used: bestResult.rpcUsed
      },
      rpc_used: bestResult.rpcUsed,
      // Enhanced bot tracking with strategy
      is_bot_operation: true,
      bot_strategy: strategyId, // Use the assigned strategy
      signature: bestResult.signature
    }

    console.log(`✅ Buy ${operationType} completed for ${token.token_symbol}: ${bestResult.outputAmount} tokens via ${bestResult.provider}${bestResult.signature ? ` (${bestResult.signature})` : ''}`)

    // Track bot operation in the trading tracker system
    if (bestResult.success) {
      try {
        await trackBotOperation('buy', token, bestResult, isSimulated, strategyId)
      } catch (trackError) {
        console.error('❌ Failed to track bot buy operation:', trackError)
        // Don't fail the operation if tracking fails
      }
    }

    // After successful buy operation, notify connected devices
    if (!isSimulated && bestResult.success && tradingKeypair) {
      try {
        await notifyTradingUpdate(tradingKeypair.publicKey.toString(), 'trade_update', {
          operationType: 'buy',
          tokenAddress: token.token_address,
          tokenSymbol: token.token_symbol,
          amount: BUY_AMOUNT_SOL
        })
      } catch (notifyError) {
        console.error('❌ Failed to notify trading update:', notifyError)
        // Don't fail the operation if notification fails
      }
    }

    // Send Discord notification for successful buy operations
    if (shouldEnableNotifications() && bestResult.success) {
      try {
        // Fetch additional data for enhanced notification
        let marketCap: number | undefined
        let riskAssessment: any
        let graduatedAt: string | null = null
        let launchpad: string | null = null

        // Get market cap from token data
        if (token.market_cap && token.market_cap > 0) {
          marketCap = token.market_cap
        }

        // Fetch Jupiter metadata to get graduatedAt
        try {
          const jupiterMeta = await fetchTokenMetadataFromJupiter(token.token_address)
          if (jupiterMeta?.graduatedAt) {
            const graduatedTimestamp = new Date(jupiterMeta.graduatedAt * 1000)
            graduatedAt = graduatedTimestamp.toISOString()
            launchpad = jupiterMeta.launchpad

            // Log graduatedAt on server
            logTradeOperation('Token Graduated Info', {
              tokenSymbol: token.token_symbol,
              tokenAddress: token.token_address,
              graduatedAt: graduatedAt,
              graduatedTimestamp: jupiterMeta.graduatedAt,
              launchpad: launchpad
            })

            console.log(`🎓 Token ${token.token_symbol} graduated at: ${graduatedAt}`)
          }
        } catch (jupiterError) {
          console.warn('Failed to fetch Jupiter metadata for graduatedAt:', jupiterError)
        }

        // Perform risk assessment
        try {
          riskAssessment = await assessTokenRisk({
            token_address: token.token_address,
            token_symbol: token.token_symbol,
            mcap: marketCap || token.market_cap || 0,
            price: token.current_price,
            change_1h: token.change_1h,
            change_5m: token.change_5m,
            organic_score: token.organic_score
          }, {
            timeoutMs: 3000,
            enableLogging: true,
            fallbackToBasic: true
          })

          // Log risk assessment results
          logTradeOperation('Buy Risk Assessment', {
            tokenSymbol: token.token_symbol,
            tokenAddress: token.token_address,
            riskLevel: riskAssessment.riskLevel,
            assessmentMethod: riskAssessment.assessmentMethod,
            marketCap
          })
        } catch (riskError) {
          console.warn('Failed to perform risk assessment:', riskError)
          riskAssessment = {
            riskLevel: 'MED',
            assessmentMethod: 'fallback',
            error: 'Assessment failed'
          }
        }

        await sendBuyNotificationDiscord({
          tokenSymbol: token.token_symbol,
          tokenAddress: token.token_address,
          isSimulated: isSimulated,
          amountSOL: BUY_AMOUNT_SOL,
          tokensReceived: bestResult.outputAmount,
          priceUSD: token.current_price,
          provider: bestResult.provider,
          rpcUsed: bestResult.rpcUsed,
          responseTime: bestResult.responseTime,
          signature: bestResult.signature,
          totalFees: bestResult.fees.totalFees,
          marketCap,
          riskAssessment,
          graduatedAt
        })
      } catch (discordError) {
        console.error('❌ Failed to send buy Discord notification:', discordError)
        // Don't fail the operation if Discord fails
      }
    }

    // Remove from active trades on completion (real trades only)
    if (!isSimulated) {
      activeTrades.delete(token.token_address)

      // Also remove from strategy-specific tracking
      const strategyActiveTrades = activeTradesByStrategy.get(strategyId)
      if (strategyActiveTrades) {
        strategyActiveTrades.delete(token.token_address)
      }

      const { recordTradingSuccess } = await import('@/utils/bot-trading-state')
      await recordTradingSuccess()
    }

    if (bestResult.success) {
      const { notifyStrategyOpen } = await import('@/strategies/strategy-telegram-notify')
      notifyStrategyOpen({
        domain: 'trending_bot',
        strategyId,
        tokenSymbol: token.token_symbol,
        tokenAddress: token.token_address,
        marketCap: token.market_cap,
        isSimulated,
      })
    }

    return buyOperation

  } catch (error) {
    console.error(`❌ Error performing buy ${simulation.is_simulated ? 'simulation' : 'real trade'} for ${token.token_symbol}:`, error)

    // Remove from active trades on error (real trades only)
    if (!isSimulated) {
      activeTrades.delete(token.token_address)

      // Also remove from strategy-specific tracking
      const strategyActiveTrades = activeTradesByStrategy.get(strategyId)
      if (strategyActiveTrades) {
        strategyActiveTrades.delete(token.token_address)
      }

      const { recordTradingFailure } = await import('@/utils/bot-trading-state')
      await recordTradingFailure(
        error instanceof Error ? error.message : 'Buy operation failed',
      )
    }

    return null
  } finally {
    if (tradeLockHeld) {
      const { releaseTradeLock } = await import('@/utils/bot-trading-state')
      await releaseTradeLock(token.token_address, strategyId)
    }
  }
}

// Unified sell operation (supports both simulation and real trading)
export async function performSellOperation(
  token: any,
  simulation: TradingSimulation,
  sellPercentage: number,
  strategyId?: string
): Promise<SellOperation | null> {
  try {
    const isSimulated = simulation.is_simulated
    const resolvedStrategy =
      strategyId ||
      simulation.buy_operation?.bot_strategy ||
      getCurrentBotStrategySync()
    const operationType = isSimulated ? 'simulation' : 'real trade'
    console.log(`💸 Performing ${sellPercentage}% sell ${operationType} for ${token.token_symbol} (${token.token_address})`)

    // Real trades with active SL/TP rows are closed by the SL/TP monitor (avoids double-sell races).
    if (!isSimulated && tradingKeypair) {
      const { hasActiveSlTpPosition } = await import('@/utils/bot-position-close')
      const deferred = await hasActiveSlTpPosition(
        tradingKeypair.publicKey.toString(),
        token.token_address,
      )
      if (deferred) {
        console.log(
          `⏭️ Deferring real sell for ${token.token_symbol} to SL/TP monitor (active sl_tp_positions row)`,
        )
        return null
      }
    }

    // SOL mint address
    const SOL_MINT = 'So11111111111111111111111111111111111111112'

    // Calculate token amount to sell based on percentage
    const totalTokenAmount = simulation.remaining_token_amount || simulation.buy_operation?.token_amount_received || '0'
    const tokenAmountToSell = parseFloat(totalTokenAmount) * (sellPercentage / 100)

    if (tokenAmountToSell <= 0) {
      throw new Error('No tokens available to sell')
    }

    // Safety checks for real trading
    if (!isSimulated) {
      // Add diagnostic logging
      console.log(`🔧 Real sell safety check for ${token.token_symbol}:`)
      console.log(`  - simulation.keypair_path: ${simulation.keypair_path || 'undefined'}`)
      console.log(`  - TRADING_KEYPAIR_JSON env var: ${process.env.TRADING_KEYPAIR_JSON ? 'SET' : 'NOT SET'}`)
      console.log(`  - Global tradingKeypair: ${tradingKeypair ? 'initialized' : 'null'}`)

      // Enhanced keypair validation - check both simulation path and environment variable
      const hasKeypairPath = !!simulation.keypair_path
      const hasEnvKeypair = !!process.env.TRADING_KEYPAIR_JSON

      if (!hasKeypairPath && !hasEnvKeypair) {
        throw new Error('Trading keypair not configured (set TRADING_KEYPAIR_JSON or provide keypair_path)')
      }

      // Check RPC health before trading
      const rpcHealth = await checkRpcHealth()
      if (!rpcHealth.healthy) {
        throw new Error(`Shyft RPC unhealthy: ${rpcHealth.error}`)
      }

      // Initialize trading infrastructure
      const connection = initializeTradingConnection()
      await initializeTradingKeypair(simulation.keypair_path)

      console.log(`🔥 Real sell safety checks passed - proceeding with sell operation`)
    }

    // Create appropriate executor
    const executor = createTradeExecutor(
      isSimulated,
      isSimulated ? undefined : tradingConnection!,
      isSimulated ? undefined : tradingSigner!
    )

    const simExecutor = isSimulated ? executor : new SimulationExecutor()

    // Test different slippage configurations  
    const slippageConfigs = [
      { key: 'slippage_1', bps: 100 },   // 1% for simulation comparison
      { key: 'slippage_2', bps: 200 },   // 2% for simulation comparison  
      { key: 'slippage_3', bps: 300 }    // 3% - required for real trades
    ]

    const configurations: any = {}
    const allResults: TradeExecutionResult[] = []

    // For real trading, use 3% slippage for execution but test all for comparison
    // For simulation, test all configurations
    const configsToTest = slippageConfigs
    const realTradeSlippage = 300 // 3% slippage for real trades
    const PRIORITY_FEE_LAMPORTS = Math.floor(0.0005 * 1e9) // 0.0005 SOL priority fee

    for (const config of configsToTest) {
      try {
        console.log(`  📊 Testing sell ${config.key} (${config.bps} bps slippage)...`)

        // For real trades, only execute with 3% slippage but record all tests
        const shouldActuallyExecute = isSimulated || config.bps === realTradeSlippage

        const exec = shouldActuallyExecute ? executor : simExecutor

        const result = await exec.executeSell({
          tokenAddress: token.token_address,
          tokenSymbol: token.token_symbol,
          inputMint: token.token_address,
          outputMint: SOL_MINT,
          amount: Math.floor(tokenAmountToSell), // Convert to integer token amount
          slippageBps: config.bps,
          userPublicKey: isSimulated ? '11111111111111111111111111111111' : tradingKeypair!.publicKey.toBase58(),
          priorityFee: shouldActuallyExecute ? PRIORITY_FEE_LAMPORTS : 0,
          strategy: strategyId || 'unknown'
        })

        configurations[config.key] = {
          success: result.success,
          response_time: result.responseTime,
          sol_amount: result.outputAmount,
          total_fees: result.fees.totalFees,
          price_impact: '0', // Will be calculated from quote
          best_provider: result.provider,
          rpc_used: result.rpcUsed,
          signature: result.signature,
          error: result.error
        }

        if (result.success) {
          allResults.push(result)
          console.log(`    ✅ ${config.key}: ${result.provider} - ${result.outputAmount} SOL, ${result.responseTime}ms${result.signature ? ` (${result.signature.slice(0, 8)}...)` : ''}`)
        } else {
          console.log(`    ❌ ${config.key}: ${result.error}`)
        }

        // For real trading, break after successful execution at 3% slippage
        if (!isSimulated && result.success && shouldActuallyExecute) {
          break
        }

      } catch (error) {
        console.error(`    ❌ ${config.key} error:`, error)
        configurations[config.key] = {
          success: false,
          response_time: 0,
          sol_amount: '0',
          total_fees: 0,
          price_impact: '0',
          best_provider: 'none',
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }

      // Small delay between configurations (simulation only)
      if (isSimulated) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    // Find best result (considering both SOL amount and fees for real trades)
    const bestResult = allResults.reduce((best, current) => {
      if (!best) return current

      const bestAmount = parseFloat(best.outputAmount)
      const currentAmount = parseFloat(current.outputAmount)

      // For real trades, also consider fees
      if (!isSimulated) {
        const bestValue = bestAmount - best.fees.totalFees
        const currentValue = currentAmount - current.fees.totalFees
        return currentValue > bestValue ? current : best
      }

      // For simulation, just compare SOL amounts
      return currentAmount > bestAmount ? current : best
    }, allResults[0])

    if (!bestResult) {
      console.log(`❌ No successful sell ${operationType} for ${token.token_symbol}`)
      return null
    }

    // Position validation for real trades
    if (!isSimulated && bestResult.success) {
      const solReceived = parseFloat(bestResult.outputAmount) / 1e9 // Convert to SOL
      const buyAmountSOL = 0.02 // Same as used in buy operation
      const expectedMinSOL = (tokenAmountToSell * token.last_price_usd * 0.8) / buyAmountSOL // At least 80% of expected

      if (solReceived < expectedMinSOL) {
        console.warn(`⚠️ Real sell trade SOL amount lower than expected: ${solReceived} < ${expectedMinSOL}`)
      } else {
        console.log(`✅ Real sell trade validated: ${solReceived} SOL received`)
      }
    }

    // Calculate remaining token amount after this sell
    const remainingTokens = (parseFloat(totalTokenAmount) * (1 - sellPercentage / 100)).toString()

    // Calculate hold duration
    const simulationStart = new Date(simulation.simulation_started_at)
    const now = new Date()
    const holdDurationHours = (now.getTime() - simulationStart.getTime()) / (1000 * 60 * 60)

    // Calculate gain percentage
    const buyPrice = simulation.buy_operation?.buy_price_usd || token.initial_price_usd
    const finalGainPercentage = calculateGainPercentage(token.last_price_usd, buyPrice)

    const sellOperation: SellOperation = {
      timestamp: new Date().toISOString(),
      sell_amount_tokens: tokenAmountToSell.toString(),
      sol_received: bestResult.outputAmount,
      sell_price_usd: token.last_price_usd,
      configurations,
      best_sell_config: {
        slippage: 1, // Will be determined from best result
        provider: bestResult.provider,
        sol_amount: bestResult.outputAmount,
        response_time: bestResult.responseTime,
        total_fees: bestResult.fees.totalFees,
        rpc_used: bestResult.rpcUsed
      },
      rpc_used: bestResult.rpcUsed,
      final_gain_percentage: finalGainPercentage,
      hold_duration_hours: holdDurationHours,
      // Enhanced bot tracking
      is_bot_operation: true,
      bot_strategy: resolvedStrategy,
      signature: bestResult.signature
    }

    // Update simulation's remaining token amount
    simulation.remaining_token_amount = remainingTokens

    const isFullClose = sellPercentage === 100 || parseFloat(remainingTokens) < 1000

    // Track bot sell operation in the trading tracker system
    if (bestResult.success) {
      try {
        const walletAddress =
          tradingKeypair?.publicKey.toString() || 'simulation'
        const { finalizeBotPositionClose } = await import('@/utils/bot-position-close')
        await finalizeBotPositionClose({
          tokenAddress: token.token_address,
          tokenSymbol: token.token_symbol,
          tokenName: token.token_name,
          logoUrl: token.logo_url,
          walletAddress,
          strategyId: resolvedStrategy,
          isSimulated,
          sellResult: bestResult,
          sellPercentage,
          currentPriceUsd: token.last_price_usd || token.current_price,
          initialPriceUsd: buyPrice,
          closeReason: 'track_route',
          isFullClose,
          priorityFee: PRIORITY_FEE_LAMPORTS,
          strictRecord: !isSimulated,
        })
      } catch (trackError) {
        console.error('❌ Failed to track bot sell operation:', trackError)
        if (!isSimulated) {
          throw trackError
        }
      }
    }

    console.log(`✅ ${sellPercentage}% sell ${operationType} completed for ${token.token_symbol}: ${bestResult.outputAmount} SOL received, ${remainingTokens} tokens remaining${bestResult.signature ? ` (${bestResult.signature})` : ''}`)

    // After successful sell operation, notify connected devices
    if (!isSimulated && bestResult.success && tradingKeypair) {
      try {
        await notifyTradingUpdate(tradingKeypair.publicKey.toString(), 'trade_update', {
          operationType: 'sell',
          tokenAddress: token.token_address,
          tokenSymbol: token.token_symbol,
          amount: sellPercentage
        })
      } catch (notifyError) {
        console.error('❌ Failed to notify trading update:', notifyError)
        // Don't fail the operation if notification fails
      }
    }

    return sellOperation

  } catch (error) {
    console.error(`❌ Error performing sell ${simulation.is_simulated ? 'simulation' : 'real trade'} for ${token.token_symbol}:`, error)
    return null
  }
}

// Helper function to check if token should be sold
export function shouldSellToken(token: TrackedToken, simulation: TradingSimulation): { shouldSell: boolean, sellPercentage: number, reason: string } {
  const currentGain = calculateGainPercentage(token.last_price_usd, token.initial_price_usd)
  const hasTP1 = simulation.sell_operations.some(op => op.final_gain_percentage >= simulation.take_profit_levels.tp1_percentage)

  // Add comprehensive logging for SL diagnosis
  console.log(`🔍 SL Check for ${token.token_symbol}:`, {
    currentPrice: token.last_price_usd,
    initialPrice: token.initial_price_usd,
    currentGain: currentGain.toFixed(2) + '%',
    stopLossThreshold: simulation.stop_loss_percentage + '%',
    simulationStatus: simulation.current_status,
    hasTP1,
    sellOperationsCount: simulation.sell_operations.length
  })

  const simulationStart = new Date(simulation.simulation_started_at)
  const now = new Date()
  const holdDurationHours = (now.getTime() - simulationStart.getTime()) / (1000 * 60 * 60)

  // Shared exit ladder (src/strategies/exit-ladder.ts) — solana semantics:
  // tp3 is a trailing stop after TP1, tp2 only fires once TP1 executed.
  const decision = decideTrendingExit({
    takeProfitLevels: simulation.take_profit_levels,
    stopLossPct: simulation.stop_loss_percentage,
    maxHoldHours: simulation.max_hold_hours,
    gainPct: currentGain,
    heldHours: holdDurationHours,
    tp1Done: hasTP1,
    tp3Style: 'trailing',
    tp2RequiresTp1: true,
  })

  if (decision.action !== 'hold') switch (decision.reason) {
    case 'stop_loss':
      console.log(`🛑 STOP LOSS TRIGGERED for ${token.token_symbol}: ${currentGain.toFixed(2)}% <= ${simulation.stop_loss_percentage}%`)
      return {
        shouldSell: true,
        sellPercentage: 100, // Sell everything
        reason: `🛑 Stop loss triggered: ${currentGain.toFixed(2)}% <= ${simulation.stop_loss_percentage}%`
      }
    case 'tp1':
      console.log(`🎯 TP1 TRIGGERED for ${token.token_symbol}: ${currentGain.toFixed(2)}% >= ${simulation.take_profit_levels.tp1_percentage}%`)
      return {
        shouldSell: true,
        sellPercentage: simulation.take_profit_levels.tp1_sell_percentage,
        reason: `🎯 TP1 reached: ${currentGain.toFixed(2)}% >= ${simulation.take_profit_levels.tp1_percentage}%`
      }
    case 'tp2':
      console.log(`🎯 TP2 TRIGGERED for ${token.token_symbol}: ${currentGain.toFixed(2)}% >= ${simulation.take_profit_levels.tp2_percentage}%`)
      return {
        shouldSell: true,
        sellPercentage: 100,
        reason: `🎯 TP2 reached: ${currentGain.toFixed(2)}% >= ${simulation.take_profit_levels.tp2_percentage}%`
      }
    case 'tp3':
      console.log(`📉 TP3 TRIGGERED for ${token.token_symbol}: ${currentGain.toFixed(2)}% <= ${simulation.take_profit_levels.tp3_percentage}% after TP1`)
      return {
        shouldSell: true,
        sellPercentage: 100,
        reason: `📉 TP3 triggered: ${currentGain.toFixed(2)}% <= ${simulation.take_profit_levels.tp3_percentage}% after TP1`
      }
    case 'max_hold':
      console.log(`⏰ MAX HOLD TIME TRIGGERED for ${token.token_symbol}: ${holdDurationHours.toFixed(1)}h >= ${simulation.max_hold_hours}h`)
      return {
        shouldSell: true,
        sellPercentage: 100,
        reason: `⏰ Max hold time reached: ${holdDurationHours.toFixed(1)}h >= ${simulation.max_hold_hours}h`
      }
  }

  console.log(`✅ No sell conditions met for ${token.token_symbol}`)
  return {
    shouldSell: false,
    sellPercentage: 0,
    reason: ''
  }
}
