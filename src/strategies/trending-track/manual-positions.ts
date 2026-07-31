// Manual position / manual sell monitoring extracted from src/app/api/trending/track/route.ts (REL-19).
import { PublicKey } from '@solana/web3.js'
import { query } from '@/utils/db'
import { calculateGainPercentage } from '@/utils/trading-math'
import { shouldEnableNotifications, sendTradeAlertDiscord } from '@/utils/discord'
import { TRACKER_TABLE } from './constants'
import { tradingConnection, tradingKeypair, monitoredTokens } from './state'
import { performSellOperation } from './trade-ops'
import type { TrackedToken, TradingSimulation } from './types'

export async function checkForManualSells(tokens: TrackedToken[]): Promise<void> {
  if (!tradingKeypair || !tradingConnection) return

  try {
    const { value: tokenAccounts } = await tradingConnection.getParsedTokenAccountsByOwner(
      tradingKeypair.publicKey,
      { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
    )

    // Process each tracked token
    for (const token of tokens) {
      if (token.status !== 'tracking' || !token.trading_simulation) continue

      const tokenAccount = tokenAccounts.find(account =>
        account.account.data.parsed.info.mint === token.token_address
      )

      const currentBalance = tokenAccount
        ? tokenAccount.account.data.parsed.info.tokenAmount.uiAmount || 0
        : 0

      const monitoredToken = monitoredTokens.get(token.token_address)

      if (monitoredToken) {
        const balanceDecrease = monitoredToken.lastBalance - currentBalance

        // Detect significant balance decrease (manual sell)
        if (balanceDecrease > 0.001 && balanceDecrease > monitoredToken.lastBalance * 0.1) {
          console.log(`🚨 Manual sell detected for ${token.token_symbol}: ${balanceDecrease.toFixed(6)} tokens sold`)

          // Mark trading simulation as manually closed
          if (token.trading_simulation) {
            token.trading_simulation.current_status = 'completed'
            token.trading_simulation.final_result = {
              ...token.trading_simulation.final_result,
              success: true,
              manual_intervention: true,
              manual_sell_detected: true
            } as any

            // Update token status to won (manual intervention)
            await query(
              `UPDATE ${TRACKER_TABLE}
               SET status = $1, status_changed_at = $2, trading_simulation = $3, updated_at = NOW()
               WHERE id = $4`,
              [
                'won',
                new Date().toISOString(),
                JSON.stringify(token.trading_simulation),
                token.id,
              ],
            )

            // Send Discord notification about manual sell
            if (shouldEnableNotifications()) {
              try {
                await sendTradeAlertDiscord({
                  tokenSymbol: token.token_symbol,
                  status: 'completed',
                  isSimulated: false,
                  currentGain: token.current_gain_percentage,
                  peakGain: token.peak_gain_percentage,
                  priceUsd: token.last_price_usd,
                  provider: 'manual',
                  rpcUsed: 'manual',
                  responseTime: 0
                })
              } catch (error) {
                console.error('❌ Failed to send manual sell Discord notification:', error)
              }
            }
          }
        }
      }

      // Update monitoring data
      monitoredTokens.set(token.token_address, {
        lastBalance: currentBalance,
        lastCheck: Date.now(),
        tokenData: token
      })
    }
  } catch (error) {
    console.error('❌ Error checking for manual sells:', error)
  }
}

export async function getManualPositionData(mintAddress: string, currentBalance: number): Promise<{
  symbol: string
  averageBuyPrice: number
  stopLossPercentage: number
  shouldMonitorSL: boolean
} | null> {
  try {
    if (!tradingKeypair) return null

    const { tradingTracker } = await import('@/utils/trading-tracker')
    const walletAddress = tradingKeypair.publicKey.toString()

    // Get trading records for this wallet
    const records = await tradingTracker.getWalletRecords(walletAddress)

    // Find buy operations for this token
    const buyRecords = records.filter(record =>
      record.operationType === 'buy' &&
      record.tokens.some(token => token.mintAddress === mintAddress)
    )

    if (buyRecords.length === 0) return null

    // Calculate average buy price from buy records
    let totalTokensBought = 0
    let totalSolSpent = 0
    let tokenSymbol = 'UNKNOWN'

    for (const record of buyRecords) {
      const tokenData = record.tokens.find(token => token.mintAddress === mintAddress)
      if (tokenData) {
        totalTokensBought += tokenData.tokenAmount || 0
        totalSolSpent += tokenData.solAmount || 0
        tokenSymbol = tokenData.symbol || tokenSymbol
      }
    }

    if (totalTokensBought === 0) return null

    const averageSolPrice = totalSolSpent / totalTokensBought
    const { getSolPriceUSD } = await import('@/utils/solana')
    const currentSolPrice = await getSolPriceUSD()
    const averageBuyPrice = averageSolPrice * currentSolPrice

    return {
      symbol: tokenSymbol,
      averageBuyPrice,
      stopLossPercentage: -50, // Default SL threshold
      shouldMonitorSL: true
    }

  } catch (error) {
    console.error('❌ Error getting manual position data:', error)
    return null
  }
}

// Enhanced manual position monitoring with stop loss support
export async function checkForManualPositionsAndSL(tokens: TrackedToken[]): Promise<void> {
  if (!tradingKeypair || !tradingConnection) return

  try {
    const { value: tokenAccounts } = await tradingConnection.getParsedTokenAccountsByOwner(
      tradingKeypair.publicKey,
      { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
    )

    console.log(`🔍 Checking ${tokenAccounts.length} token accounts for manual positions and SL triggers`)

    // Get current token prices for SL calculations
    const tokenAddresses = tokenAccounts.map(account => account.account.data.parsed.info.mint)
    const { fetchTokenPricesForTracking } = await import('@/utils/trading-tracker')
    const tokenPrices = await fetchTokenPricesForTracking(tokenAddresses)

    // Process each token account for manual positions
    for (const tokenAccount of tokenAccounts) {
      const mintAddress = tokenAccount.account.data.parsed.info.mint
      const currentBalance = tokenAccount.account.data.parsed.info.tokenAmount.uiAmount || 0

      // Skip if balance is too small (dust)
      if (currentBalance < 0.001) continue

      const currentPrice = tokenPrices[mintAddress]
      if (!currentPrice) continue

      // Check if this is a tracked token with simulation
      const trackedToken = tokens.find(t => t.token_address === mintAddress)

      if (trackedToken && trackedToken.trading_simulation) {
        // This is an automatic position - already handled by main SL logic
        continue
      }

      // This is a manual position - check for SL trigger
      const manualPosition = await getManualPositionData(mintAddress, currentBalance)

      if (manualPosition && manualPosition.shouldMonitorSL) {
        const currentGain = calculateGainPercentage(currentPrice, manualPosition.averageBuyPrice)
        const stopLossThreshold = manualPosition.stopLossPercentage || -50 // Default -50%

        console.log(`🔍 Manual Position SL Check for ${manualPosition.symbol}:`, {
          currentPrice,
          averageBuyPrice: manualPosition.averageBuyPrice,
          currentGain: currentGain.toFixed(2) + '%',
          stopLossThreshold: stopLossThreshold + '%',
          balance: currentBalance
        })

        if (currentGain <= stopLossThreshold) {
          console.log(`🛑 MANUAL POSITION STOP LOSS TRIGGERED for ${manualPosition.symbol}: ${currentGain.toFixed(2)}% <= ${stopLossThreshold}%`)

          // Execute sell for manual position
          await executeManualPositionSL(mintAddress, manualPosition, currentBalance, currentPrice, currentGain)
        }
      }
    }

    // Also check existing tracked tokens for manual sell detection (existing logic)
    await checkForManualSells(tokens)

  } catch (error) {
    console.error('❌ Error checking manual positions and SL:', error)
  }
}

// Execute stop loss for manual position
export async function executeManualPositionSL(
  mintAddress: string,
  positionData: any,
  balance: number,
  currentPrice: number,
  currentGain: number
): Promise<void> {
  try {
    console.log(`🛑 Executing manual position stop loss for ${positionData.symbol}`)

    // Create a mock token object for the sell operation
    const mockToken = {
      token_address: mintAddress,
      token_symbol: positionData.symbol,
      current_price: currentPrice
    }

    // Create a mock simulation for the sell operation
    const mockSimulation: TradingSimulation = {
      token_address: mintAddress,
      token_symbol: positionData.symbol,
      simulation_started_at: new Date().toISOString(),
      is_simulated: false, // Execute real trade
      current_status: 'holding',
      remaining_token_amount: balance.toString(),
      initial_token_amount: balance.toString(),
      stop_loss_percentage: positionData.stopLossPercentage,
      take_profit_levels: {
        tp1_percentage: 80,
        tp1_sell_percentage: 80,
        tp2_percentage: 100,
        tp3_percentage: 30,
        tp3_enabled: true
      },
      max_hold_hours: 72,
      buy_operation: null,
      sell_operations: [],
      final_result: null
    }

    // Execute the sell operation
    const sellOperation = await performSellOperation(mockToken, mockSimulation, 100) // Sell 100%

    if (sellOperation) {
      console.log(`✅ Manual position SL executed for ${positionData.symbol}:`, {
        solReceived: parseFloat(sellOperation.sol_received) / 1e9,
        finalGain: currentGain.toFixed(2) + '%'
      })

      // Track the sell operation
      if (tradingKeypair) {
        const { tradingTracker } = await import('@/utils/trading-tracker')
        await tradingTracker.trackOperation({
          walletAddress: tradingKeypair.publicKey.toString(),
          operationType: 'sell',
          tokens: [{
            mintAddress,
            symbol: positionData.symbol,
            tokenAmount: balance,
            solAmount: parseFloat(sellOperation.sol_received) / 1e9,
            priceUsd: currentPrice
          }],
          successCount: 1,
          failureCount: 0,
          totalTokens: 1,
          solAmount: parseFloat(sellOperation.sol_received) / 1e9,
          feesPaid: sellOperation.best_sell_config?.total_fees || 0,
          signatures: sellOperation.signature ? [sellOperation.signature] : [],
          is_bot_operation: true,
          bot_strategy: 'manual-position-stop-loss'
        })
      }

      // Send Discord notification
      if (shouldEnableNotifications()) {
        try {
          await sendTradeAlertDiscord({
            tokenSymbol: positionData.symbol,
            status: 'completed',
            isSimulated: false,
            currentGain,
            peakGain: currentGain, // Use current gain as peak for manual positions
            priceUsd: currentPrice,
            provider: sellOperation.best_sell_config?.provider || 'jupiter',
            rpcUsed: sellOperation.best_sell_config?.rpc_used || 'default',
            responseTime: sellOperation.best_sell_config?.response_time || 0
          })
        } catch (error) {
          console.error('❌ Failed to send manual SL Discord notification:', error)
        }
      }
    } else {
      console.error(`❌ Failed to execute manual position SL for ${positionData.symbol}`)
    }

  } catch (error) {
    console.error('❌ Error executing manual position SL:', error)
  }
}
