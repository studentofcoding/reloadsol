// Wallet / risk / duplicate-prevention helpers extracted from src/app/api/trending/track/route.ts (REL-19).
import { PublicKey } from '@solana/web3.js'
import { query } from '@/utils/db'
import { getActiveStrategiesSync } from '@/strategies/load-strategy'
import {
  MIN_SOL_BALANCE,
  MAX_SOL_AT_RISK,
  MAX_PURCHASES_PER_TOKEN,
  MIN_WALLET_BALANCE_FOR_DUPLICATE_CHECK,
  TRACKER_TABLE,
} from './constants'
import {
  tradingConnection,
  tradingKeypair,
  activeTrades,
  activeTradesByStrategy,
  initializeTradingConnection,
  initializeTradingKeypair,
} from './state'
import type { TradingSimulation } from './types'

export async function diagnoseTradingWallet(): Promise<void> {
  console.log('🔧 === WALLET DIAGNOSTICS ===')

  try {
    // Check environment variables
    const hasEnvKeypair = !!process.env.TRADING_KEYPAIR_JSON
    console.log(`📋 TRADING_KEYPAIR_JSON env var: ${hasEnvKeypair ? 'SET' : 'NOT SET'}`)

    if (hasEnvKeypair) {
      try {
        const envJson = JSON.parse(process.env.TRADING_KEYPAIR_JSON!)
        console.log(`📋 Keypair JSON length: ${envJson.length} bytes`)
      } catch (e) {
        console.error('❌ Invalid TRADING_KEYPAIR_JSON format:', e)
      }
    }

    // Check MIN_SOL_BALANCE
    console.log(`📋 MIN_SOL_BALANCE: ${MIN_SOL_BALANCE} SOL`)

    // Initialize and test connection
    if (!tradingConnection) {
      console.log('🌐 Initializing trading connection...')
      initializeTradingConnection()
    }

    if (tradingConnection) {
      console.log('✅ Trading connection initialized')

      // Test RPC connection
      try {
        const slot = await tradingConnection.getSlot()
        console.log(`✅ RPC connection healthy, current slot: ${slot}`)
      } catch (rpcError) {
        console.error('❌ RPC connection failed:', rpcError)
      }
    }

    // Initialize and test keypair
    if (!tradingKeypair) {
      console.log('🔑 Initializing trading keypair...')
      await initializeTradingKeypair()
    }

    if (tradingKeypair) {
      console.log(`✅ Trading keypair loaded: ${tradingKeypair.publicKey.toBase58()}`)

      // Test balance fetch
      if (tradingConnection) {
        try {
          const balance = await tradingConnection.getBalance(tradingKeypair.publicKey)
          const balanceSOL = balance / 1e9
          console.log(`✅ Wallet balance: ${balanceSOL.toFixed(4)} SOL`)
          console.log(`✅ Can trade: ${balanceSOL >= MIN_SOL_BALANCE}`)
        } catch (balanceError) {
          console.error('❌ Balance fetch failed:', balanceError)
        }
      }
    } else {
      console.error('❌ Failed to load trading keypair')
    }

  } catch (error) {
    console.error('❌ Wallet diagnostics failed:', error)
  }

  console.log('🔧 === END DIAGNOSTICS ===')
}

export async function checkRpcHealth(): Promise<{ healthy: boolean, latency?: number, error?: string }> {
  try {
    const connection = initializeTradingConnection()
    const startTime = Date.now()

    // Test RPC by getting latest blockhash
    await connection.getLatestBlockhash('confirmed')
    const latency = Date.now() - startTime

    console.log(`🏥 Shyft RPC health check passed (${latency}ms)`)
    return { healthy: true, latency }
  } catch (error) {
    console.error('❌ Shyft RPC health check failed:', error)
    return {
      healthy: false,
      error: error instanceof Error ? error.message : 'Unknown RPC error'
    }
  }
}

export async function checkTradingBalance(): Promise<{ balance: number, canTrade: boolean }> {
  try {
    // Ensure trading infrastructure is initialized before checking balance
    if (!tradingConnection) {
      console.log('🔧 Initializing trading connection for balance check...')
      initializeTradingConnection()
    }

    if (!tradingKeypair) {
      console.log('🔑 Initializing trading keypair for balance check...')
      await initializeTradingKeypair()
    }

    if (!tradingConnection || !tradingKeypair) {
      console.error('❌ Failed to initialize trading infrastructure for balance check')
      return { balance: 0, canTrade: false }
    }

    console.log(`🔍 Checking balance for wallet: ${tradingKeypair.publicKey.toBase58()}`)

    const balance = await tradingConnection.getBalance(tradingKeypair.publicKey)
    const balanceSOL = balance / 1e9
    const canTrade = balanceSOL >= MIN_SOL_BALANCE

    console.log(`💰 Wallet balance: ${balanceSOL.toFixed(4)} SOL (minimum required: ${MIN_SOL_BALANCE} SOL, can trade: ${canTrade})`)

    return { balance: balanceSOL, canTrade }
  } catch (error) {
    console.error('❌ Error checking trading balance:', error)
    return { balance: 0, canTrade: false }
  }
}

export async function getTotalSOLAtRisk(): Promise<number> {
  // Fetch only required fields to keep payload light
  const { rows: activeRealTrades } = await query<{ trading_simulation: TradingSimulation }>(
    `SELECT trading_simulation FROM ${TRACKER_TABLE}
     WHERE status = 'tracking' AND trading_simulation IS NOT NULL`,
  )

  let totalAtRisk = 0

  for (const trade of activeRealTrades) {
    const simulation = trade.trading_simulation as TradingSimulation

    // Skip simulated positions entirely
    if (simulation.is_simulated) continue

    // Only consider simulations whose buy actually reached the chain (has signature)
    const buySig = (simulation.buy_operation as any)?.signature
    if (!buySig) continue

    // We only count positions that are still holding tokens
    if (simulation.current_status !== 'holding') continue

    const remaining = parseFloat(simulation.remaining_token_amount || '0')
    const initial = parseFloat(simulation.initial_token_amount || '0')

    // Ignore if effectively closed (dust remaining)
    if (!initial || remaining < 1e-6) continue

    // Pro-rate original SOL spent by the fraction of tokens still held
    const proportionRemaining = Math.min(1, remaining / initial)
    const spentSOL = simulation.buy_operation?.buy_amount_sol || 0

    totalAtRisk += spentSOL * proportionRemaining
  }

  return totalAtRisk
}

// Add strategy-specific risk calculation
export async function getTotalSOLAtRiskByStrategy(strategyId: string): Promise<number> {
  // Fetch only required fields to keep payload light
  const { rows: activeRealTrades } = await query<{ trading_simulation: TradingSimulation }>(
    `SELECT trading_simulation FROM ${TRACKER_TABLE}
     WHERE status = 'tracking' AND trading_simulation IS NOT NULL`,
  )

  let totalAtRisk = 0

  for (const trade of activeRealTrades) {
    const simulation = trade.trading_simulation as TradingSimulation

    // Skip simulated positions entirely
    if (simulation.is_simulated) continue

    // Only consider simulations whose buy actually reached the chain (has signature)
    const buySig = (simulation.buy_operation as any)?.signature
    if (!buySig) continue

    // Only count trades from this strategy
    const tradeStrategy = (simulation.buy_operation as any)?.bot_strategy
    if (tradeStrategy !== strategyId) continue

    // We only count positions that are still holding tokens
    if (simulation.current_status !== 'holding') continue

    const remaining = parseFloat(simulation.remaining_token_amount || '0')
    const initial = parseFloat(simulation.initial_token_amount || '0')

    // Ignore if effectively closed (dust remaining)
    if (!initial || remaining < 1e-6) continue

    // Pro-rate original SOL spent by the fraction of tokens still held
    const proportionRemaining = Math.min(1, remaining / initial)
    const spentSOL = simulation.buy_operation?.buy_amount_sol || 0

    totalAtRisk += spentSOL * proportionRemaining
  }

  return totalAtRisk
}

// Enhanced duplicate prevention functions
export async function checkWalletHoldings(tokenAddress: string, currentPrice?: number): Promise<{
  hasSignificantHolding: boolean,
  balance: number,
  shouldRebuyPreviouslySold: boolean,
  rebuyReason?: string,
  originalPurchasePrice?: number
}> {
  if (!tradingConnection || !tradingKeypair) {
    return { hasSignificantHolding: false, balance: 0, shouldRebuyPreviouslySold: false }
  }

  try {
    // Get token account for this mint
    const { value: tokenAccounts } = await tradingConnection.getParsedTokenAccountsByOwner(
      tradingKeypair.publicKey,
      { mint: new PublicKey(tokenAddress) }
    )

    let totalBalance = 0
    if (tokenAccounts.length > 0) {
      // Sum up all token account balances for this mint
      totalBalance = tokenAccounts.reduce((sum, account) => {
        const amount = account.account.data.parsed.info.tokenAmount.uiAmount
        return sum + (amount || 0)
      }, 0)
    }

    const hasSignificantHolding = totalBalance >= MIN_WALLET_BALANCE_FOR_DUPLICATE_CHECK

    // Check for previously sold tokens that might qualify for re-buy
    let shouldRebuyPreviouslySold = false
    let rebuyReason: string | undefined
    let originalPurchasePrice: number | undefined

    if (!hasSignificantHolding && currentPrice) {
      // Look for completed (sold) tokens with this address
      const { rows: completedTokens } = await query<{
        id: string
        token_address: string
        token_symbol: string | null
        initial_price_usd: number
        trading_simulation: TradingSimulation
        tracking_started_at: string
      }>(
        `SELECT id, token_address, token_symbol, initial_price_usd, trading_simulation, tracking_started_at
         FROM ${TRACKER_TABLE}
         WHERE token_address = $1
           AND status = ANY($2::text[])
           AND trading_simulation IS NOT NULL
         ORDER BY tracking_started_at DESC
         LIMIT 1`,
        [tokenAddress, ['completed', 'won', 'lost']],
      )

      if (completedTokens.length > 0) {
        const lastCompletedToken = completedTokens[0]
        const simulation = lastCompletedToken.trading_simulation as TradingSimulation

        // Only consider real trades (not simulations)
        if (simulation && !simulation.is_simulated && simulation.buy_operation) {
          const originalPrice = simulation.buy_operation.buy_price_usd
          const priceThreshold = originalPrice * 0.25 // 25% of original price

          if (currentPrice < priceThreshold) {
            shouldRebuyPreviouslySold = true
            originalPurchasePrice = originalPrice
            rebuyReason = `Current price $${currentPrice.toFixed(8)} < 25% of original purchase price $${originalPrice.toFixed(8)} (threshold: $${priceThreshold.toFixed(8)})`

            console.log(`🔄 Re-buy opportunity detected for ${lastCompletedToken.token_symbol}: ${rebuyReason}`)
          }
        }
      }
    }

    console.log(`🔍 Wallet holdings check for ${tokenAddress}: ${totalBalance} tokens (significant: ${hasSignificantHolding}), rebuy: ${shouldRebuyPreviouslySold}`)

    return {
      hasSignificantHolding,
      balance: totalBalance,
      shouldRebuyPreviouslySold,
      rebuyReason,
      originalPurchasePrice
    }
  } catch (error) {
    console.error(`❌ Error checking wallet holdings for ${tokenAddress}:`, error)
    return { hasSignificantHolding: false, balance: 0, shouldRebuyPreviouslySold: false }
  }
}

export async function checkRecentPurchaseHistory(tokenAddress: string, tokenSymbol: string | null, currentPrice?: number): Promise<{ shouldPrevent: boolean, reason?: string }> {
  try {
    // Check database for recent purchases of this token - changed to 5 minutes
    const cutoffTime = new Date(Date.now() - 5 * 60 * 1000) // 5 minutes instead of hours

    const { rows: recentTokens } = await query<{
      id: string
      token_address: string
      token_symbol: string | null
      tracking_started_at: string
      trading_simulation: TradingSimulation | null
      status: string
      initial_price_usd: number
    }>(
      `SELECT id, token_address, token_symbol, tracking_started_at, trading_simulation, status, initial_price_usd
       FROM ${TRACKER_TABLE}
       WHERE token_address = $1 AND tracking_started_at >= $2
       ORDER BY tracking_started_at DESC`,
      [tokenAddress, cutoffTime.toISOString()],
    )

    if (recentTokens.length === 0) {
      console.log(`✅ No recent purchases found for ${tokenSymbol}`)
      return { shouldPrevent: false }
    }

    // Count only real trading attempts (not pure simulations)
    const realTradeAttempts = recentTokens.filter(token => {
      const simulation = token.trading_simulation as TradingSimulation | null
      return simulation && !simulation.is_simulated && simulation.buy_operation
    })

    // Count all purchase attempts (including simulations that might become real trades)
    const allAttempts = recentTokens.length

    console.log(`📊 Purchase history for ${tokenSymbol}: ${realTradeAttempts.length} real trades, ${allAttempts} total attempts in last 5 minutes`)

    // Prevent if we've hit the maximum purchases limit
    if (realTradeAttempts.length >= MAX_PURCHASES_PER_TOKEN) {
      const lastPurchase = recentTokens[0].tracking_started_at
      const minutesAgo = Math.round((Date.now() - new Date(lastPurchase).getTime()) / (1000 * 60))
      return {
        shouldPrevent: true,
        reason: `Maximum purchases reached: ${realTradeAttempts.length}/${MAX_PURCHASES_PER_TOKEN} for ${tokenSymbol}. Last purchase ${minutesAgo}m ago. Cooldown: 5m`
      }
    }

    // Prevent if we have recent attempts (even if under the max)
    if (allAttempts > 0) {
      const lastAttempt = recentTokens[0].tracking_started_at
      const minutesAgo = Math.round((Date.now() - new Date(lastAttempt).getTime()) / (1000 * 60))

      if (minutesAgo < 5) { // Minimum 5 minute gap between attempts
        // If current price is available, compare with the last attempt's price
        if (currentPrice && recentTokens[0].initial_price_usd) {
          const lastPrice = recentTokens[0].initial_price_usd
          const priceChangePercentage = Math.abs(((currentPrice - lastPrice) / lastPrice) * 100)

          console.log(`📊 Price comparison for ${tokenSymbol}: Current $${currentPrice.toFixed(8)}, Last $${lastPrice.toFixed(8)}, Change: ${priceChangePercentage.toFixed(2)}%`)

          // Only proceed if price change is >= 20%
          if (priceChangePercentage >= 20) {
            console.log(`✅ Price change ${priceChangePercentage.toFixed(2)}% >= 20% - allowing purchase despite recent attempt`)
            return { shouldPrevent: false }
          } else {
            return {
              shouldPrevent: true,
              reason: `Recent purchase attempt for ${tokenSymbol} only ${minutesAgo}m ago with price change ${priceChangePercentage.toFixed(2)}% < 20%. Minimum 5m gap or 20% price change required.`
            }
          }
        } else {
          return {
            shouldPrevent: true,
            reason: `Recent purchase attempt for ${tokenSymbol} only ${minutesAgo}m ago. Minimum 5m gap required.`
          }
        }
      }
    }

    return { shouldPrevent: false }
  } catch (error) {
    console.error(`❌ Error checking recent purchase history for ${tokenSymbol}:`, error)
    return { shouldPrevent: false }
  }
}

export async function performEnhancedDuplicateCheck(tokenAddress: string, tokenSymbol: string | null, currentPrice?: number): Promise<{
  canPurchase: boolean,
  reason?: string,
  isRebuy?: boolean,
  rebuyMultiplier?: number
}> {
  console.log(`🔍 Performing enhanced duplicate check for ${tokenSymbol} (${tokenAddress})`)

  // Check 1: Active trades (immediate duplicates)
  if (activeTrades.has(tokenAddress)) {
    return { canPurchase: false, reason: `Trade already in progress for ${tokenSymbol}` }
  }

  // Check 2: Wallet holdings and re-buy opportunities
  const { hasSignificantHolding, balance, shouldRebuyPreviouslySold, rebuyReason } = await checkWalletHoldings(tokenAddress, currentPrice)

  if (hasSignificantHolding) {
    return {
      canPurchase: false,
      reason: `Wallet already holds significant amount of ${tokenSymbol}: ${balance.toLocaleString()} tokens`
    }
  }

  // Special case: Allow re-buy of previously sold tokens at reduced amount
  if (shouldRebuyPreviouslySold) {
    console.log(`🔄 Re-buy approved for ${tokenSymbol}: ${rebuyReason}`)
    return {
      canPurchase: true,
      isRebuy: true,
      rebuyMultiplier: 0.3 // Use 30% of normal buy amount
    }
  }

  // Check 3: Recent purchase history with price comparison
  const { shouldPrevent, reason } = await checkRecentPurchaseHistory(tokenAddress, tokenSymbol, currentPrice)
  if (shouldPrevent) {
    return { canPurchase: false, reason }
  }

  console.log(`✅ Enhanced duplicate check passed for ${tokenSymbol}`)
  return { canPurchase: true }
}

export async function canExecuteRealTrade(buyAmountSOL: number, tokenAddress?: string, tokenSymbol?: string, currentPrice?: number): Promise<{
  canTrade: boolean,
  reason?: string,
  adjustedBuyAmount?: number,
  isRebuy?: boolean
}> {
  // Maintain backward compatibility - use first active strategy
  const { strategies } = getActiveStrategiesSync()
  return canExecuteRealTradeWithStrategy(buyAmountSOL, strategies[0], tokenAddress, tokenSymbol, currentPrice)
}

// Update balance checking for multi-strategy
export async function canExecuteRealTradeWithStrategy(
  buyAmountSOL: number,
  strategyId: string,
  tokenAddress?: string,
  tokenSymbol?: string,
  currentPrice?: number
): Promise<{
  canTrade: boolean,
  reason?: string,
  adjustedBuyAmount?: number,
  isRebuy?: boolean
}> {
  console.log(`🔍 Checking if real trade can be executed for ${tokenSymbol || 'unknown'} using ${strategyId} strategy (${buyAmountSOL} SOL)`)

  const { isRealTradingHalted } = await import('@/utils/bot-trading-state')
  const halt = await isRealTradingHalted()
  if (halt.halted) {
    return { canTrade: false, reason: halt.reason || 'Real trading circuit breaker is open' }
  }

  // Check if we can execute a real trade
  const { balance, canTrade: hasBalance } = await checkTradingBalance()

  if (!hasBalance) {
    const errorMsg = `Insufficient balance: ${balance.toFixed(4)} SOL < ${MIN_SOL_BALANCE} SOL minimum`
    console.error(`❌ ${errorMsg}`)
    return { canTrade: false, reason: errorMsg }
  }

  console.log(`✅ Balance check passed: ${balance.toFixed(4)} SOL >= ${MIN_SOL_BALANCE} SOL minimum`)

  let adjustedBuyAmount = buyAmountSOL
  let isRebuy = false

  // Enhanced duplicate prevention check (strategy-aware)
  if (tokenAddress) {
    const strategyActiveTrades = activeTradesByStrategy.get(strategyId) || new Set()

    if (strategyActiveTrades.has(tokenAddress)) {
      return { canTrade: false, reason: `Trade already in progress for ${tokenSymbol} in ${strategyId} strategy` }
    }

    const duplicateCheck = await performEnhancedDuplicateCheck(tokenAddress, tokenSymbol || null, currentPrice)
    if (!duplicateCheck.canPurchase) {
      console.log(`❌ Duplicate check failed: ${duplicateCheck.reason}`)
      return { canTrade: false, reason: duplicateCheck.reason }
    }

    // Adjust buy amount for re-buy scenarios
    if (duplicateCheck.isRebuy && duplicateCheck.rebuyMultiplier) {
      adjustedBuyAmount = buyAmountSOL * duplicateCheck.rebuyMultiplier
      isRebuy = true
      console.log(`🔄 Adjusting buy amount for re-buy: ${buyAmountSOL} SOL → ${adjustedBuyAmount} SOL (${(duplicateCheck.rebuyMultiplier * 100)}%)`)
    }
  }

  // Calculate strategy-specific risk
  const totalAtRisk = await getTotalSOLAtRiskByStrategy(strategyId)
  const { allocation } = getActiveStrategiesSync()
  const strategyMaxRisk = MAX_SOL_AT_RISK * (allocation[strategyId] || 0.25) // Default 25% if not specified
  const newTotalAtRisk = totalAtRisk + adjustedBuyAmount

  console.log(`📊 Strategy ${strategyId} risk analysis: Current at risk: ${totalAtRisk.toFixed(4)} SOL, New total: ${newTotalAtRisk.toFixed(4)} SOL, Max allowed: ${strategyMaxRisk.toFixed(4)} SOL`)

  if (newTotalAtRisk > strategyMaxRisk) {
    const errorMsg = `Strategy ${strategyId} risk limit exceeded: ${newTotalAtRisk.toFixed(4)} SOL > ${strategyMaxRisk.toFixed(4)} SOL maximum`
    console.error(`❌ ${errorMsg}`)
    return { canTrade: false, reason: errorMsg }
  }

  if (balance < adjustedBuyAmount + MIN_SOL_BALANCE) {
    const errorMsg = `Insufficient balance for trade: need ${(adjustedBuyAmount + MIN_SOL_BALANCE).toFixed(4)} SOL, have ${balance.toFixed(4)} SOL`
    console.error(`❌ ${errorMsg}`)
    return { canTrade: false, reason: errorMsg }
  }

  console.log(`✅ Real trade check passed for ${strategyId} strategy: ${adjustedBuyAmount} SOL trade approved`)
  return { canTrade: true, adjustedBuyAmount, isRebuy }
}