import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'
import { supabase } from '@/utils/supabase'
import { Connection, VersionedTransaction, Keypair, PublicKey } from '@solana/web3.js'
import { getSwapQuote, getSwapTransaction } from '@/utils/jupiter'
import { compareTradeQuotes, performEnhancedTradeComparison } from '@/utils/trade-comparison'
import { JupiterBaseAsset, JupiterPool, JupiterResponse } from '@/types'

export const runtime = 'nodejs'

// ====================================================================================================
// REAL TRADING SETUP INSTRUCTIONS:
// ====================================================================================================
// To enable REAL trading (not simulation), you need to set up the following environment variables:
//
// 1. TRADING_KEYPAIR_JSON: Your wallet's private key as a JSON array
//    Example: [123,45,67,89...] (the secret key from your Solana wallet)
//    You can get this from your wallet export or Phantom wallet's "Export Private Key"
//
// 2. DISCORD_WEBHOOK_AUTO_TRADE: Discord webhook URL for trade notifications
//    Example: https://discord.com/api/webhooks/YOUR_WEBHOOK_URL
//
// 3. Optional safety limits:
//    - MAX_SOL_AT_RISK=1.0 (maximum SOL that can be at risk across all trades)
//    - MIN_SOL_BALANCE=0.1 (minimum SOL balance to maintain)
//
// To activate real trading for new tokens, use the PUT endpoint:
// PUT /api/trending/track?key=YOUR_SECRET_KEY
// Body: { "isSimulated": false }
//
// The system will then show "🔥 LIVE TRADING" in Discord notifications instead of "💻 SIMULATION"
// ====================================================================================================

// Lightweight toggle for verbose logging
const DEBUG_LOG = process.env.DEBUG === '1' || process.env.DEBUG === 'true'
// Optional debug logger – only prints when DEBUG env is truthy
const dbg = (...args: any[]): void => {
  if (DEBUG_LOG) {
    console.log(...args)
  }
}

// === Table selection (use alternate tables in local development to avoid prod collisions) ===
const TRACKER_TABLE = process.env.NODE_ENV === 'development' ? 'trending_token_tracker_dev' : 'trending_token_tracker'
const SUMMARY_TABLE = process.env.NODE_ENV === 'development' ? 'trending_token_summary_dev' : 'trending_token_summary'

// Add PriceRecord interface for price history
interface PriceRecord {
  timestamp: string
  price_usd: number
  volume: number | null
}

interface TrackedToken {
  id: string
  token_address: string
  token_symbol: string | null
  token_name: string | null
  logo_url: string | null
  initial_price_usd: number
  last_price_usd: number
  peak_price_usd: number
  current_gain_percentage: number
  peak_gain_percentage: number
  status: 'waiting' | 'tracking' | 'won' | 'lost' | 'skipped' | 'stopped'
  organic_score: number | null
  market_cap: number | null
  volume_1h: number | null
  volume_5m: number | null
  tracking_started_at: string
  status_changed_at: string | null
  created_at: string
  updated_at: string
  trading_simulation?: TradingSimulation | null
  price_history?: PriceRecord[] | null
  // New fields for waiting system
  waiting_started_at?: string | null
  waiting_initial_price?: number | null
}

// Add TopWinner interface for summary functionality
interface TopWinner {
  token_address: string
  token_symbol: string | null
  token_name: string | null
  logo_url: string | null
  initial_price_usd: number
  peak_price_usd: number
  peak_gain_percentage: number
  tracking_duration_hours: number
  status_changed_at: string
}

// Add TradeComparisonResult interface for trade analysis
interface TradeComparisonResult {
  token_address: string
  token_symbol: string | null
  timestamp: string
  buy_amount_sol: number
  comparisons: {
    [key: string]: {
      success: boolean
      response_time: number
      token_amount: string
      total_fees: number
      price_impact: string
      best_provider: string
      rpc_used?: string
      error?: string
    }
  }
  best_config: {
    slippage: number
    provider: string
    token_amount: string
    response_time: number
    total_fees: number
    rpc_used?: string
  }
}

// Add TradingSimulation interfaces
interface BuyOperation {
  timestamp: string
  buy_amount_sol: number
  token_amount_received: string
  buy_price_usd: number
  configurations: {
    slippage_1: BuyConfigResult
    slippage_2: BuyConfigResult
    slippage_3: BuyConfigResult
  }
  best_buy_config: {
    slippage: number
    provider: string
    token_amount: string
    response_time: number
    total_fees: number
    rpc_used: string
  }
  rpc_used: string
  // Enhanced bot tracking
  is_bot_operation?: boolean
  bot_strategy?: string
  signature?: string
}

interface SellOperation {
  timestamp: string
  sell_amount_tokens: string
  sol_received: string
  sell_price_usd: number
  configurations: {
    slippage_1: SellConfigResult
    slippage_2: SellConfigResult
    slippage_3: SellConfigResult
  }
  best_sell_config: {
    slippage: number
    provider: string
    sol_amount: string
    response_time: number
    total_fees: number
    rpc_used: string
  }
  rpc_used: string
  final_gain_percentage: number
  hold_duration_hours: number
  // Enhanced bot tracking
  is_bot_operation?: boolean
  bot_strategy?: string
  signature?: string
}

interface BuyConfigResult {
  success: boolean
  response_time: number
  token_amount: string
  total_fees: number
  price_impact: string
  best_provider: string
  error?: string
}

interface SellConfigResult {
  success: boolean
  response_time: number
  sol_amount: string
  total_fees: number
  price_impact: string
  best_provider: string
  error?: string
}

// Add type definition for trading simulation status
type TradingSimulationStatus = 'buying' | 'holding' | 'selling' | 'completed' | 'failed'

interface TradingSimulation {
  token_address: string
  token_symbol: string | null
  simulation_started_at: string
  buy_operation: BuyOperation | null
  sell_operations: SellOperation[]
  current_status: TradingSimulationStatus
  remaining_token_amount: string
  initial_token_amount: string
  is_simulated: boolean
  keypair_path?: string
  take_profit_levels: {
    tp1_percentage: number
    tp1_sell_percentage: number
    tp2_percentage: number
    tp3_percentage: number
    tp3_enabled: boolean
  }
  stop_loss_percentage: number
  max_hold_hours: number
  final_result: {
    success: boolean
    total_gain_percentage: number
    total_gain_sol: number
    buy_price_usd: number
    sell_price_usd: number
    hold_duration_hours: number
    best_buy_config: {
      slippage: number
      provider: string
      token_amount: string
      response_time: number
      total_fees: number
      rpc_used: string
    }
    best_sell_configs: {
      slippage: number
      provider: string
      sol_amount: string
      response_time: number
      total_fees: number
      rpc_used: string
    }[]
  } | null
}

// Add unified trade execution system
interface TradeExecutionParams {
  tokenAddress: string
  tokenSymbol: string | null
  inputMint: string
  outputMint: string
  amount: number // in lamports for input token
  slippageBps: number
  userPublicKey: string
  priorityFee?: number
}

interface TradeExecutionResult {
  success: boolean
  signature?: string
  inputAmount: string
  outputAmount: string
  fees: {
    totalFees: number
    feePercentage: number
  }
  provider: string
  rpcUsed: string
  responseTime: number
  error?: string
}

interface TradeExecutor {
  executeBuy(params: TradeExecutionParams): Promise<TradeExecutionResult>
  executeSell(params: TradeExecutionParams): Promise<TradeExecutionResult>
}

// Simulation executor (existing logic)
class SimulationExecutor implements TradeExecutor {
  async executeBuy(params: TradeExecutionParams): Promise<TradeExecutionResult> {
    try {
      const comparison = await compareTradeQuotes({
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amount.toString(),
        slippageBps: params.slippageBps,
        userPublicKey: params.userPublicKey
      })

      if (comparison.bestQuote && comparison.bestQuote.success) {
        const bestQuote = comparison.bestQuote
        return {
          success: true,
          inputAmount: bestQuote.inAmount,
          outputAmount: bestQuote.outAmount,
          fees: {
            totalFees: bestQuote.fees?.totalFeeLamports ? bestQuote.fees.totalFeeLamports / 1e9 : 0,
            feePercentage: bestQuote.fees?.feePercentage || 0
          },
          provider: bestQuote.provider,
          rpcUsed: 'simulation',
          responseTime: bestQuote.responseTime,
        }
      } else {
        return {
          success: false,
          inputAmount: params.amount.toString(),
          outputAmount: '0',
          fees: { totalFees: 0, feePercentage: 0 },
          provider: 'none',
          rpcUsed: 'none',
          responseTime: 0,
          error: 'No successful quotes available'
        }
      }
    } catch (error) {
      return {
        success: false,
        inputAmount: params.amount.toString(),
        outputAmount: '0',
        fees: { totalFees: 0, feePercentage: 0 },
        provider: 'none',
        rpcUsed: 'none',
        responseTime: 0,
        error: error instanceof Error ? error.message : 'Simulation failed'
      }
    }
  }

  async executeSell(params: TradeExecutionParams): Promise<TradeExecutionResult> {
    // Same logic as executeBuy but for sell direction
    return this.executeBuy(params)
  }
}

// Real trade executor (new implementation)
class RealTradeExecutor implements TradeExecutor {
  private connection: Connection
  private signer: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>

  constructor(connection: Connection, signer: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>) {
    this.connection = connection
    this.signer = signer
  }

  async executeBuy(params: TradeExecutionParams): Promise<TradeExecutionResult> {
    return this.executeSwap(params, 'buy')
  }

  async executeSell(params: TradeExecutionParams): Promise<TradeExecutionResult> {
    return this.executeSwap(params, 'sell')
  }

  private async executeSwap(params: TradeExecutionParams, direction: 'buy' | 'sell'): Promise<TradeExecutionResult> {
    const startTime = Date.now()

    // Enhanced logging for real trades
    logTradeOperation(`Real Trade ${direction.toUpperCase()} Started`, {
      tokenAddress: params.tokenAddress,
      tokenSymbol: params.tokenSymbol,
      amount: params.amount,
      slippageBps: params.slippageBps,
      userPublicKey: params.userPublicKey,
      direction
    })

    try {
      // Get quote first (always use Jupiter for real trades)
      console.log(`🔄 Getting Jupiter quote for ${direction} ${params.tokenSymbol}...`)
      const quote = await getSwapQuote(
        params.inputMint,
        params.outputMint,
        params.amount,
        params.slippageBps
      )

      if (!quote) {
        throw new Error('No valid Jupiter quote available')
      }

      console.log(`📊 Jupiter quote received: ${quote.inAmount} → ${quote.outAmount}`)

      // Create transaction
      console.log(`🔧 Creating swap transaction...`)
      const swapTransaction = await getSwapTransaction(
        quote,
        params.userPublicKey,
        params.priorityFee || 0,
        []
      )

      if (!swapTransaction) {
        throw new Error('Failed to create Jupiter swap transaction')
      }

      // Deserialize and sign transaction
      console.log(`✍️ Signing transaction...`)
      const tx = VersionedTransaction.deserialize(
        Buffer.from(swapTransaction.swapTransaction, 'base64')
      )

      const signedTxs = await this.signer([tx])
      const signedTx = signedTxs[0]

      // Send transaction with retries
      console.log(`📡 Sending transaction to Shyft RPC...`)
      let signature: string | undefined
      let sendAttempts = 0
      const maxSendAttempts = 3

      while (sendAttempts < maxSendAttempts) {
        try {
          signature = await this.connection.sendTransaction(signedTx, {
            skipPreflight: true,
            maxRetries: 1,
          })
          break
        } catch (error) {
          sendAttempts++
          console.warn(`📡 Send attempt ${sendAttempts} failed:`, error)
          if (sendAttempts >= maxSendAttempts) {
            throw new Error(`Failed to send transaction after ${maxSendAttempts} attempts: ${error}`)
          }
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 1000 * sendAttempts))
        }
      }

      if (!signature) {
        throw new Error('Failed to get transaction signature')
      }

      console.log(`⏳ Confirming transaction ${signature}...`)

      // Enhanced transaction confirmation with timeout
      const confirmationPromise = this.connection.confirmTransaction(signature, 'confirmed')
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Transaction confirmation timeout')), 30000)
      )

      await Promise.race([confirmationPromise, timeoutPromise])

      const responseTime = Date.now() - startTime

      const result = {
        success: true,
        signature,
        inputAmount: quote.inAmount,
        outputAmount: quote.outAmount,
        fees: {
          totalFees: quote.platformFee ? parseInt(quote.platformFee.amount) / 1e9 : 0,
          feePercentage: quote.platformFee ? quote.platformFee.feeBps / 100 : 0
        },
        provider: 'jupiter',
        rpcUsed: 'shyft',
        responseTime,
      }

      // Log successful real trade
      logTradeOperation(`Real Trade ${direction.toUpperCase()} SUCCESS`, {
        tokenSymbol: params.tokenSymbol,
        signature,
        inputAmount: quote.inAmount,
        outputAmount: quote.outAmount,
        responseTime,
        fees: result.fees.totalFees
      })

      return result
    } catch (error) {
      const responseTime = Date.now() - startTime

      // Enhanced error logging for real trades
      logTradeOperation(`Real Trade ${direction.toUpperCase()} FAILED`, {
        tokenSymbol: params.tokenSymbol,
        direction,
        amount: params.amount,
        slippageBps: params.slippageBps,
        responseTime,
        userPublicKey: params.userPublicKey
      }, error as Error)

      return {
        success: false,
        inputAmount: params.amount.toString(),
        outputAmount: '0',
        fees: { totalFees: 0, feePercentage: 0 },
        provider: 'jupiter',
        rpcUsed: 'shyft',
        responseTime,
        error: error instanceof Error ? error.message : 'Real trade failed'
      }
    }
  }
}

// Factory function to create appropriate executor
function createTradeExecutor(
  isSimulated: boolean,
  connection?: Connection,
  signer?: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>
): TradeExecutor {
  if (isSimulated) {
    return new SimulationExecutor()
  } else {
    if (!connection || !signer) {
      throw new Error('Connection and signer required for real trading')
    }
    return new RealTradeExecutor(connection, signer)
  }
}

// Keypair management utilities
function loadTradingKeypair(keypairPath?: string): Keypair {
  // Prefer env-var when running in serverless environments (e.g. Vercel)
  const envJson = process.env.TRADING_KEYPAIR_JSON
  if (envJson) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(envJson)))
  }

  // Fallback to reading from file for local development / self-hosted runs
  if (keypairPath) {
    const fs = require('fs')
    const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf8'))
    return Keypair.fromSecretKey(Uint8Array.from(keypairData))
  }

  throw new Error('Trading keypair not provided. Set TRADING_KEYPAIR_JSON env or supply keypairPath.')
}

function createSignerFromKeypair(keypair: Keypair): (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]> {
  return async (transactions: VersionedTransaction[]): Promise<VersionedTransaction[]> => {
    return transactions.map(tx => {
      tx.sign([keypair])
      return tx
    })
  }
}

// Add helper functions for gain calculations
function calculateGainPercentage(currentPrice: number, initialPrice: number): number {
  if (!initialPrice || initialPrice <= 0) {
    console.warn('Invalid initial price for gain calculation:', initialPrice)
    return 0
  }

  // Round to 4 decimal places to avoid floating point precision issues
  return Math.round(((currentPrice - initialPrice) / initialPrice) * 10000) / 100
}

function calculatePeakPrice(currentPrice: number, existingPeakPrice: number): number {
  // Ensure we don't store invalid peak prices
  if (currentPrice <= 0) return existingPeakPrice

  // If no existing peak price (0), set current as peak
  if (!existingPeakPrice) return currentPrice

  // Only update peak if current is higher
  return currentPrice > existingPeakPrice ? currentPrice : existingPeakPrice
}

// Add interface for price tracking
interface PriceTracking {
  initialPrice: number
  currentPrice: number
  peakPrice: number
  currentGain: number
  peakGain: number
  lastUpdated: string
}

// === Discord Trade Alert Configuration ===
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_AUTO_TRADE || ''

// Enhanced logging helper
function logTradeOperation(operation: string, data: any, error?: Error) {
  const timestamp = new Date().toISOString()
  const logData = {
    timestamp,
    operation,
    ...data,
    error: error ? {
      message: error.message,
      stack: error.stack
    } : undefined
  }
  console.log(`[${timestamp}] ${operation}:`, JSON.stringify(logData, null, 2))
}

// Helper to determine if notifications should be enabled
function shouldEnableNotifications(): boolean {
  const enabled = DISCORD_WEBHOOK_URL !== ''
  logTradeOperation('Discord Status Check', {
    enabled,
    webhookConfigured: !!DISCORD_WEBHOOK_URL
  })
  return enabled
}

// Update the Discord notification parameter types
type TradeAlertStatus = 'buy' | 'partial-sell' | 'completed'

// Discord notification for new token detection
async function sendNewTokenDetectionDiscord(params: {
  tokenAddress: string
  tokenSymbol: string | null
  tokenName: string | null
  currentPrice: number
  marketCap: number | null
  organicScore: number | null
  volume1h: number | null
  isRealTrading: boolean
}) {
  try {
    // Check if Discord notifications are enabled
    if (!shouldEnableNotifications()) {
      logTradeOperation('Discord New Token Notification Skipped', {
        reason: 'Notifications disabled',
        webhookStatus: 'not configured'
      })
      return
    }

    const {
      tokenAddress,
      tokenSymbol,
      tokenName,
      currentPrice,
      marketCap,
      organicScore,
      volume1h,
      isRealTrading
    } = params

    // Log notification attempt
    logTradeOperation('Discord New Token Notification Attempt', {
      tokenSymbol,
      tokenAddress,
      isRealTrading,
      currentPrice,
      marketCap
    })

    const emoji = isRealTrading ? '🔥' : '💻'
    const mode = isRealTrading ? 'LIVE TRADING' : 'SIMULATION'

    // Create reloadSOL swap link as requested
    const reloadSolLink = `https://v2.reloadsol.xyz/buy?sol=0.1&mints=${tokenAddress}`

    const lines = [
      `${emoji} New Token Detected (${mode})`,
      ``,
      `📊 **${tokenSymbol || 'UNKNOWN'}** (${tokenName || 'Unknown Name'})`,
      `💰 Price: $${currentPrice.toFixed(8)}`,
      `🏦 Market Cap: ${marketCap ? `$${(marketCap / 1000000).toFixed(2)}M` : 'N/A'}`,
      `🎯 Organic Score: ${organicScore ? `${organicScore.toFixed(1)}` : 'N/A'}`,
      `📈 Volume 1h: ${volume1h ? `$${(volume1h / 1000).toFixed(1)}K` : 'N/A'}`,
      ``,
      `🔗 **Trade on reloadSOL:**`,
      reloadSolLink,
      ``,
      `⏰ ${new Date().toLocaleString()}`
    ]

    const content = lines.join('\n')

    // Add request timing
    const fetchStartTime = Date.now()
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    })

    const webhookResponseTime = Date.now() - fetchStartTime

    if (!response.ok) {
      const responseText = await response.text()
      throw new Error(`Discord webhook failed: ${response.status} ${response.statusText}\nResponse: ${responseText}`)
    }

    // Log successful notification
    logTradeOperation('Discord New Token Notification Success', {
      tokenSymbol,
      tokenAddress,
      isRealTrading,
      responseTime: webhookResponseTime,
      httpStatus: response.status
    })
  } catch (err) {
    // Enhanced error logging
    logTradeOperation('Discord New Token Notification Error', {
      tokenSymbol: params.tokenSymbol,
      tokenAddress: params.tokenAddress,
      isRealTrading: params.isRealTrading
    }, err as Error)

    // Re-throw for upstream handling if needed
    throw err
  }
}

// Discord notification for successful buy operations
async function sendBuyNotificationDiscord(params: {
  tokenSymbol: string | null
  tokenAddress: string
  isSimulated: boolean
  amountSOL: number
  tokensReceived: string
  priceUSD: number
  provider: string
  rpcUsed: string
  responseTime: number
  signature?: string
  totalFees: number
}) {
  try {
    // Check if Discord notifications are enabled
    if (!shouldEnableNotifications()) {
      logTradeOperation('Discord Buy Notification Skipped', {
        reason: 'Notifications disabled',
        webhookStatus: 'not configured'
      })
      return
    }

    const {
      tokenSymbol,
      tokenAddress,
      isSimulated,
      amountSOL,
      tokensReceived,
      priceUSD,
      provider,
      rpcUsed,
      responseTime,
      signature,
      totalFees
    } = params

    // Log notification attempt
    logTradeOperation('Discord Buy Notification Attempt', {
      tokenSymbol,
      tokenAddress,
      isSimulated,
      amountSOL,
      provider,
      signature: signature ? `${signature.slice(0, 8)}...` : 'none'
    })

    const emoji = isSimulated ? '💻' : '🔥'
    const mode = isSimulated ? 'SIMULATION' : 'LIVE'
    const title = `${emoji} BUY Executed (${mode})`

    const lines = [
      title,
      ``,
      `🪙 **${tokenSymbol || 'UNKNOWN'}**`,
      `💰 Spent: ${amountSOL} SOL`,
      `🎯 Received: ${parseFloat(tokensReceived).toLocaleString()} tokens`,
      `📊 Price: $${priceUSD.toFixed(8)}`,
      `⚡ Provider: ${provider}`,
      `🌐 RPC: ${rpcUsed}`,
      `⏱️ Response: ${responseTime}ms`,
      `💸 Fees: ${totalFees.toFixed(6)} SOL`
    ]

    // Add signature for real trades
    if (signature && !isSimulated) {
      lines.push(`🔗 Signature: \`${signature}\``)
      lines.push(`📍 [View on Solscan](https://solscan.io/tx/${signature})`)
    }

    lines.push(``)
    lines.push(`⏰ ${new Date().toLocaleString()}`)

    const content = lines.join('\n')

    // Add request timing
    const fetchStartTime = Date.now()
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    })

    const webhookResponseTime = Date.now() - fetchStartTime

    if (!response.ok) {
      const responseText = await response.text()
      throw new Error(`Discord webhook failed: ${response.status} ${response.statusText}\nResponse: ${responseText}`)
    }

    // Log successful notification
    logTradeOperation('Discord Buy Notification Success', {
      tokenSymbol,
      isSimulated,
      signature: signature ? `${signature.slice(0, 8)}...` : 'none',
      responseTime: webhookResponseTime,
      httpStatus: response.status
    })
  } catch (err) {
    // Enhanced error logging
    logTradeOperation('Discord Buy Notification Error', {
      tokenSymbol: params.tokenSymbol,
      isSimulated: params.isSimulated,
      amountSOL: params.amountSOL,
      signature: params.signature ? `${params.signature.slice(0, 8)}...` : 'none'
    }, err as Error)

    // Re-throw for upstream handling if needed
    throw err
  }
}

// Updated Discord alert function with enhanced error handling
async function sendTradeAlertDiscord(params: {
  tokenSymbol: string | null
  status: TradeAlertStatus
  isSimulated: boolean
  currentGain: number
  peakGain: number
  priceUsd: number
  provider?: string
  rpcUsed?: string
  responseTime?: number
}) {
  try {
    // Check if Discord notifications are enabled
    if (!shouldEnableNotifications()) {
      logTradeOperation('Discord Notification Skipped', {
        reason: 'Notifications disabled',
        webhookStatus: 'not configured'
      })
      return
    }

    const {
      tokenSymbol,
      status,
      isSimulated,
      currentGain,
      peakGain,
      priceUsd,
      provider,
      rpcUsed,
      responseTime
    } = params

    // Log notification attempt
    logTradeOperation('Discord Notification Attempt', {
      tokenSymbol,
      status,
      isSimulated,
      currentGain,
      peakGain,
      provider
    })

    const title = `🔔 Trade Alert (${isSimulated ? 'Simulation' : 'LIVE'})`

    const lines = [
      `${status} triggered for ${tokenSymbol ?? 'UNKNOWN'}`,
      `Current Gain: ${currentGain.toFixed(2)}%`,
      `Peak Gain: ${peakGain.toFixed(2)}%`,
      `Price: ${priceUsd.toFixed(6)}`
    ]

    if (provider) lines.push(`Provider: ${provider}`)
    if (rpcUsed) lines.push(`RPC: ${rpcUsed}`)
    if (responseTime !== undefined) lines.push(`Response Time: ${responseTime}ms`)
    lines.push(`Time: ${new Date().toLocaleString()}`)

    const content = [title, ...lines].join('\n')

    // Add request timing
    const fetchStartTime = Date.now()
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    })

    const webhookResponseTime = Date.now() - fetchStartTime

    if (!response.ok) {
      const responseText = await response.text()
      throw new Error(`Discord webhook failed: ${response.status} ${response.statusText}\nResponse: ${responseText}`)
    }

    // Log successful notification
    logTradeOperation('Discord Notification Success', {
      tokenSymbol,
      status,
      responseTime: webhookResponseTime,
      httpStatus: response.status
    })
  } catch (err) {
    // Enhanced error logging
    logTradeOperation('Discord Notification Error', {
      tokenSymbol: params.tokenSymbol,
      status: params.status,
      currentGain: params.currentGain
    }, err as Error)

    // Re-throw for upstream handling if needed
    throw err
  }
}

// Discord notification for skipped tokens (already exist in database)
async function sendSkippedTokenDiscord(params: {
  tokenSymbol: string | null
  tokenAddress: string
  currentPriceAPI: number
  existingTokenData: {
    status: string
    initial_price_usd: number | null
    last_price_usd: number | null
    peak_price_usd: number | null
    current_gain_percentage: number | null
    peak_gain_percentage: number | null
    tracking_started_at: string | null
    status_changed_at: string | null
    updated_at: string | null
  }
}) {
  try {
    const webhookUrl = 'https://discord.com/api/webhooks/1388575606098100256/c4e6BM2W-htcl2hUF9f_nZcchJZXCgoEe5mV95gDKODTfOto97w9BEjW8C2CgL0QwXrP'

    const timeSinceTracking = params.existingTokenData.tracking_started_at
      ? Math.round((Date.now() - new Date(params.existingTokenData.tracking_started_at).getTime()) / (1000 * 60 * 60 * 24) * 100) / 100
      : 'Unknown'

    const timeSinceStatusChange = params.existingTokenData.status_changed_at
      ? Math.round((Date.now() - new Date(params.existingTokenData.status_changed_at).getTime()) / (1000 * 60 * 60 * 24) * 100) / 100
      : 'N/A'

    const lastUpdateTime = params.existingTokenData.updated_at
      ? Math.round((Date.now() - new Date(params.existingTokenData.updated_at).getTime()) / (1000 * 60)) / 100
      : 'Unknown'

    const priceChangeVsDB = params.existingTokenData.last_price_usd
      ? ((params.currentPriceAPI - params.existingTokenData.last_price_usd) / params.existingTokenData.last_price_usd * 100).toFixed(2)
      : 'N/A'

    const currentVsPeak = params.existingTokenData.peak_price_usd && params.existingTokenData.last_price_usd
      ? ((params.existingTokenData.last_price_usd / params.existingTokenData.peak_price_usd - 1) * 100).toFixed(2)
      : 'N/A'

    const message = `🚫 **Token Skipped - Already Exists**\n\n` +
      `**Token:** ${params.tokenSymbol || 'Unknown'} (${params.tokenAddress.slice(0, 8)}...)\n` +
      `**Status:** ${params.existingTokenData.status}\n` +
      `**Initial Price:** $${params.existingTokenData.initial_price_usd?.toFixed(6) || 'N/A'}\n` +
      `**Last Price (DB):** $${params.existingTokenData.last_price_usd?.toFixed(6) || 'N/A'}\n` +
      `**Current Price (API):** $${params.currentPriceAPI?.toFixed(6)}\n` +
      `**Price Change vs DB:** ${priceChangeVsDB}%\n` +
      `**Peak Price:** $${params.existingTokenData.peak_price_usd?.toFixed(6) || 'N/A'}\n` +
      `**Current PnL:** ${params.existingTokenData.current_gain_percentage?.toFixed(2) || '0.00'}%\n` +
      `**Peak PnL:** ${params.existingTokenData.peak_gain_percentage?.toFixed(2) || '0.00'}%\n` +
      `**Current vs Peak:** ${currentVsPeak}%\n` +
      `**Tracking Started:** ${timeSinceTracking} days ago\n` +
      `**Status Changed:** ${timeSinceStatusChange !== 'N/A' ? `${timeSinceStatusChange} days ago` : 'Never'}\n` +
      `**Last Updated:** ${lastUpdateTime} minutes ago`

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message })
    })

    console.log(`📤 Discord notification sent for skipped token: ${params.tokenSymbol}`)
  } catch (error) {
    console.error(`❌ Failed to send Discord notification for skipped token ${params.tokenSymbol}:`, error)
  }
}

// Helper function to check when last summary was run
async function checkLastSummaryTime(): Promise<Date | null> {
  try {
    const { data, error } = await supabase
      .from(SUMMARY_TABLE)
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !data || data.length === 0) {
      return null
    }

    return new Date(data[0].created_at)
  } catch (error) {
    console.error('Error checking last summary time:', error)
    return null
  }
}

// Helper function to determine if daily summary should run
function shouldRunDailySummary(currentTime: Date, lastSummaryTime: Date | null): boolean {
  if (!lastSummaryTime) {
    return true // No previous summary, run it
  }

  // Check if it's been more than 23 hours since last summary
  const hoursSinceLastSummary = (currentTime.getTime() - lastSummaryTime.getTime()) / (1000 * 60 * 60)

  // Run daily summary once per day (allow 23+ hours gap to avoid missing due to slight timing differences)
  return hoursSinceLastSummary >= 23
}

// Helper function to check if PnL update should run (once daily at 2 AM UTC)
function shouldRunPnLUpdate(currentTime: Date): boolean {
  const hour = currentTime.getUTCHours()
  const minute = currentTime.getUTCMinutes()

  // Run PnL update at 2 AM UTC (allow 5-minute window: 2:00-2:05)
  return hour === 2 && minute < 5
}

// Helper function to run PnL update
async function runPnLUpdate(): Promise<void> {
  try {
    console.log('🔄 Running PnL update...')

    // Call the PnL update API internally
    const pnlResponse = await fetch(`${process.env.VERCEL_URL || 'http://localhost:3000'}/api/pnl/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'vercel-cron-internal'
      }
    })

    if (pnlResponse.ok) {
      const pnlResult = await pnlResponse.json()
      console.log('✅ PnL update completed:', pnlResult)
    } else {
      console.error('❌ PnL update failed:', pnlResponse.status, await pnlResponse.text())
    }
  } catch (error) {
    console.error('❌ Error running PnL update:', error)
    // Don't throw - let tracking continue even if PnL update fails
  }
}

// Helper function to run daily summary
async function runDailySummary(currentTime: Date): Promise<void> {
  try {
    const periodStart = new Date(currentTime.getTime() - 24 * 60 * 60 * 1000) // 24 hours ago

    // Get all tokens that were tracked in the last 24 hours
    const { data: allTokens, error: fetchError } = await supabase
      .from(TRACKER_TABLE)
      .select(`id, token_address, token_symbol, token_name, logo_url, initial_price_usd, peak_price_usd, peak_gain_percentage, current_gain_percentage, status, tracking_started_at`)
      .gte('tracking_started_at', periodStart.toISOString())

    if (fetchError) {
      throw new Error(`Failed to fetch tracked tokens: ${fetchError.message}`)
    }

    if (!allTokens || allTokens.length === 0) {
      console.log('📭 No tokens tracked in the last 24 hours for summary')
      return
    }

    const tokens = allTokens as TrackedToken[]
    console.log(`🔍 Found ${tokens.length} tokens tracked in the last 24 hours for summary`)

    // Categorize tokens
    const trackingTokens = tokens.filter(t => t.status === 'tracking')
    const lostTokens = tokens.filter(t => t.status === 'lost')
    const wonTokens = tokens.filter(t => t.status === 'won')

    // Identify top 5 performers among tracking tokens
    const topPerformers = trackingTokens
      .filter(token => token.peak_gain_percentage > 0) // Only consider profitable tokens
      .sort((a, b) => b.peak_gain_percentage - a.peak_gain_percentage)
      .slice(0, 5)

    console.log(`🏆 Found ${topPerformers.length} top performers to mark as winners`)

    // Mark top performers as "won"
    const updatePromises: Promise<any>[] = []
    topPerformers.forEach(token => {
      updatePromises.push(
        (async () => {
          const { error } = await supabase
            .from(TRACKER_TABLE)
            .update({
              status: 'won',
              status_changed_at: currentTime.toISOString()
            })
            .eq('id', token.id)
          if (error) throw error
        })()
      )
    })

    // Execute all updates
    const results = await Promise.allSettled(updatePromises)
    const failedUpdates = results.filter(result => result.status === 'rejected')

    if (failedUpdates.length > 0) {
      console.error(`⚠️ ${failedUpdates.length} winner updates failed:`, failedUpdates)
    }

    // Calculate statistics
    const totalCompleted = lostTokens.length + topPerformers.length + wonTokens.length
    const totalWon = topPerformers.length + wonTokens.length
    const winRate = totalCompleted > 0 ? (totalWon / totalCompleted) * 100 : 0

    // Calculate summary statistics
    const allGains = [...topPerformers, ...wonTokens].map(t => t.peak_gain_percentage)
    const allLosses = lostTokens.map(t => Math.abs(t.current_gain_percentage))

    const avgPeakGain = allGains.length > 0 ? allGains.reduce((a, b) => a + b, 0) / allGains.length : 0
    const maxPeakGain = allGains.length > 0 ? Math.max(...allGains) : 0
    const avgLoss = allLosses.length > 0 ? allLosses.reduce((a, b) => a + b, 0) / allLosses.length : 0

    // Prepare top winners data for storage
    const topWinnersData: TopWinner[] = topPerformers.map(token => {
      const trackingStart = new Date(token.tracking_started_at)
      const trackingDuration = (currentTime.getTime() - trackingStart.getTime()) / (1000 * 60 * 60)

      return {
        token_address: token.token_address,
        token_symbol: token.token_symbol,
        token_name: token.token_name,
        logo_url: token.logo_url,
        initial_price_usd: token.initial_price_usd,
        peak_price_usd: token.peak_price_usd,
        peak_gain_percentage: token.peak_gain_percentage,
        tracking_duration_hours: Math.round(trackingDuration * 100) / 100,
        status_changed_at: currentTime.toISOString()
      }
    })

    // Create summary record
    const summaryId = `summary_${Date.now()}`
    const { error: summaryError } = await supabase
      .from(SUMMARY_TABLE)
      .insert({
        id: summaryId,
        period_start: periodStart.toISOString(),
        period_end: currentTime.toISOString(),
        total_tokens_tracked: tokens.length,
        won_tokens: totalWon,
        lost_tokens: lostTokens.length,
        still_tracking: trackingTokens.length - topPerformers.length,
        win_rate: Math.round(winRate * 100) / 100,
        top_winners: topWinnersData,
        avg_peak_gain: Math.round(avgPeakGain * 100) / 100,
        max_peak_gain: Math.round(maxPeakGain * 100) / 100,
        avg_loss: Math.round(avgLoss * 100) / 100
      })

    if (summaryError) {
      throw new Error(`Failed to save summary: ${summaryError.message}`)
    }

    console.log(`✅ Daily summary completed: ${tokens.length} tokens tracked, ${totalWon} won, ${lostTokens.length} lost, win rate: ${winRate.toFixed(1)}%`)
  } catch (error) {
    console.error('❌ Error running daily summary:', error)
    // Don't throw - let tracking continue even if summary fails
  }
}

// Enhanced bot operation tracking helper
async function trackBotOperation(
  operationType: 'buy' | 'sell',
  token: any,
  bestResult: TradeExecutionResult,
  isSimulated: boolean,
  strategy: string = 'auto-trending'
): Promise<void> {
  try {
    // Only track if we have a keypair (real bot operations)
    if (!tradingKeypair && !isSimulated) return

    const { getSolPriceUSD } = await import('@/utils/solana')
    const { tradingTracker } = await import('@/utils/trading-tracker')

    const currentSolPrice = await getSolPriceUSD()
    const walletAddress = tradingKeypair?.publicKey.toString() || 'simulation'

    const tokenData = {
      mintAddress: token.token_address,
      symbol: token.token_symbol,
      name: token.token_name,
      logoURI: token.logo_url,
      priceUsd: token.current_price || token.last_price_usd,
      tokenAmount: parseFloat(bestResult.outputAmount) || 0,
      solPrice: currentSolPrice,
      // Remove bot fields from token data - they belong on the main record
    }

    // Calculate SOL amount based on operation type
    const solAmount = operationType === 'buy'
      ? 0.015 // Fixed buy amount
      : parseFloat(bestResult.outputAmount) / 1e9 // Convert lamports to SOL for sells

    await tradingTracker.trackOperation({
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
      slippage: 3, // 3% slippage for bot operations
      priorityFee: 100000, // 0.0001 SOL priority fee
      errors: undefined,
      // ✅ FIXED: Move bot operation fields to the main record level
      is_bot_operation: true,
      bot_strategy: strategy
    })

    console.log(`🤖 Bot operation tracked: ${operationType} ${token.token_symbol} (${strategy})`)

    // ✅ NEW: Trigger real-time sync for UI updates
    await triggerPnLSync(walletAddress)
  } catch (error) {
    console.error(`❌ Failed to track bot operation:`, error)
    // Don't throw - continue with the operation even if tracking fails
  }
}

// ✅ NEW: Function to trigger PnL synchronization
async function triggerPnLSync(walletAddress: string): Promise<void> {
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

// Wallet balance monitoring for manual sell detection
const monitoredTokens = new Map<string, {
  lastBalance: number
  lastCheck: number
  tokenData: any
}>()

// Enhanced manual sell detection
async function checkForManualSells(tokens: TrackedToken[]): Promise<void> {
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
            await supabase
              .from(TRACKER_TABLE)
              .update({
                status: 'won',
                status_changed_at: new Date().toISOString(),
                trading_simulation: token.trading_simulation
              })
              .eq('id', token.id)

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

// Unified buy operation (supports both simulation and real trading)
async function performBuyOperation(token: any, simulation: TradingSimulation): Promise<BuyOperation | null> {
  try {
    const isSimulated = simulation.is_simulated
    const operationType = isSimulated ? 'simulation' : 'real trade'
    console.log(`💰 Performing buy ${operationType} for ${token.token_symbol} (${token.token_address})`)

    // SOL mint address and trading parameters
    const SOL_MINT = 'So11111111111111111111111111111111111111112'
    let BUY_AMOUNT_SOL = 0.015 // Default 0.015 SOL per token as specified

    let isRebuy = false

    // Check if this is a real trade and if we need to adjust the buy amount for re-buy
    if (!isSimulated) {
      const tradeCheck = await canExecuteRealTrade(BUY_AMOUNT_SOL, token.token_address, token.token_symbol, token.current_price)

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
    }

    const BUY_AMOUNT_LAMPORTS = Math.floor(BUY_AMOUNT_SOL * 1e9)
    const PRIORITY_FEE_SOL = 0.001 // 0.001 SOL priority fee as specified
    const PRIORITY_FEE_LAMPORTS = Math.floor(PRIORITY_FEE_SOL * 1e9)

    // Safety checks for real trading
    if (!isSimulated) {
      if (!simulation.keypair_path) {
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

    // Choose executors
    const executor = createTradeExecutor(
      isSimulated,
      isSimulated ? undefined : tradingConnection!,
      isSimulated ? undefined : tradingSigner!
    )

    // When doing a real trade we still want paper comparisons for other slippages
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

    for (const config of configsToTest) {
      try {
        console.log(`  📊 Testing ${config.key} (${config.bps} bps slippage)...`)

        // For real trades, only the 3 % config hits chain – others use SimulationExecutor
        const shouldActuallyExecute = isSimulated || config.bps === realTradeSlippage
        const exec = shouldActuallyExecute ? executor : simExecutor

        const result = await exec.executeBuy({
          tokenAddress: token.token_address,
          tokenSymbol: token.token_symbol,
          inputMint: SOL_MINT,
          outputMint: token.token_address,
          amount: BUY_AMOUNT_LAMPORTS,
          slippageBps: config.bps,
          userPublicKey: isSimulated ? '11111111111111111111111111111111' : tradingKeypair!.publicKey.toBase58(),
          priorityFee: shouldActuallyExecute ? PRIORITY_FEE_LAMPORTS : 0
        })

        configurations[config.key] = {
          success: result.success,
          response_time: result.responseTime,
          token_amount: result.outputAmount,
          total_fees: result.fees.totalFees,
          price_impact: '0', // Will be calculated from quote
          best_provider: result.provider,
          rpc_used: result.rpcUsed,
          signature: result.signature,
          error: result.error
        }

        if (result.success) {
          allResults.push(result)
          console.log(`    ✅ ${config.key}: ${result.provider} - ${result.outputAmount} tokens, ${result.responseTime}ms${result.signature ? ` (${result.signature.slice(0, 8)}...)` : ''}`)
        } else {
          console.log(`    ❌ ${config.key}: ${result.error}`)
        }

        // For real trading, break loop once the live 3 % trade succeeded –
        // we already gathered simulation results for other configs.
        if (!isSimulated && result.success && shouldActuallyExecute) {
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
      // Enhanced bot tracking
      is_bot_operation: true,
      bot_strategy: 'auto-trending-tracker',
      signature: bestResult.signature
    }

    console.log(`✅ Buy ${operationType} completed for ${token.token_symbol}: ${bestResult.outputAmount} tokens via ${bestResult.provider}${bestResult.signature ? ` (${bestResult.signature})` : ''}`)

    // Track bot operation in the trading tracker system
    if (bestResult.success) {
      try {
        await trackBotOperation('buy', token, bestResult, isSimulated, 'auto-trending-tracker')
      } catch (trackError) {
        console.error('❌ Failed to track bot buy operation:', trackError)
        // Don't fail the operation if tracking fails
      }
    }

    // Send Discord notification for successful buy operations
    if (shouldEnableNotifications() && bestResult.success) {
      try {
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
          totalFees: bestResult.fees.totalFees
        })
      } catch (discordError) {
        console.error('❌ Failed to send buy Discord notification:', discordError)
        // Don't fail the operation if Discord fails
      }
    }

    // Remove from active trades on completion (real trades only)
    if (!isSimulated) {
      activeTrades.delete(token.token_address)
    }

    return buyOperation

  } catch (error) {
    console.error(`❌ Error performing buy ${simulation.is_simulated ? 'simulation' : 'real trade'} for ${token.token_symbol}:`, error)

    // Remove from active trades on error (real trades only)
    if (!simulation.is_simulated) {
      activeTrades.delete(token.token_address)
    }

    return null
  }
}

// Legacy function for backward compatibility
async function performBuySimulation(token: any): Promise<BuyOperation | null> {
  const mockSimulation: TradingSimulation = {
    token_address: token.token_address,
    token_symbol: token.token_symbol,
    simulation_started_at: new Date().toISOString(),
    buy_operation: null,
    sell_operations: [],
    current_status: 'buying',
    remaining_token_amount: '0',
    initial_token_amount: '0',
    is_simulated: true,
    take_profit_levels: {
      tp1_percentage: 50,
      tp1_sell_percentage: 50,
      tp2_percentage: 100,
      tp3_percentage: 200,
      tp3_enabled: true
    },
    stop_loss_percentage: -30,
    max_hold_hours: 24,
    final_result: null
  }

  return performBuyOperation(token, mockSimulation)
}

// Unified sell operation (supports both simulation and real trading)
async function performSellOperation(
  token: any,
  simulation: TradingSimulation,
  sellPercentage: number
): Promise<SellOperation | null> {
  try {
    const isSimulated = simulation.is_simulated
    const operationType = isSimulated ? 'simulation' : 'real trade'
    console.log(`💸 Performing ${sellPercentage}% sell ${operationType} for ${token.token_symbol} (${token.token_address})`)

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
      if (!simulation.keypair_path) {
        throw new Error('Trading keypair not configured (set TRADING_KEYPAIR_JSON or provide keypair_path)')
      }

      // Initialize trading infrastructure
      const connection = initializeTradingConnection()
      await initializeTradingKeypair(simulation.keypair_path)
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
          priorityFee: shouldActuallyExecute ? PRIORITY_FEE_LAMPORTS : 0
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
      bot_strategy: 'auto-trending-tracker',
      signature: bestResult.signature
    }

    // Update simulation's remaining token amount
    simulation.remaining_token_amount = remainingTokens

    // Track bot sell operation in the trading tracker system
    if (bestResult.success) {
      try {
        await trackBotOperation('sell', token, bestResult, isSimulated, 'auto-trending-tracker')
      } catch (trackError) {
        console.error('❌ Failed to track bot sell operation:', trackError)
        // Don't fail the operation if tracking fails
      }
    }

    console.log(`✅ ${sellPercentage}% sell ${operationType} completed for ${token.token_symbol}: ${bestResult.outputAmount} SOL received, ${remainingTokens} tokens remaining${bestResult.signature ? ` (${bestResult.signature})` : ''}`)
    return sellOperation

  } catch (error) {
    console.error(`❌ Error performing sell ${simulation.is_simulated ? 'simulation' : 'real trade'} for ${token.token_symbol}:`, error)
    return null
  }
}

// Helper function to check if token should be sold
function shouldSellToken(token: TrackedToken, simulation: TradingSimulation): { shouldSell: boolean, sellPercentage: number, reason: string } {
  const currentGain = calculateGainPercentage(token.last_price_usd, token.initial_price_usd)
  const hasTP1 = simulation.sell_operations.some(op => op.final_gain_percentage >= simulation.take_profit_levels.tp1_percentage)

  // Check stop loss (-50%)
  if (currentGain <= simulation.stop_loss_percentage) {
    return {
      shouldSell: true,
      sellPercentage: 100, // Sell everything
      reason: `🛑 Stop loss triggered: ${currentGain.toFixed(2)}% <= ${simulation.stop_loss_percentage}%`
    }
  }

  // Check TP1 (80%) - Sell 80% of position
  if (!hasTP1 && currentGain >= simulation.take_profit_levels.tp1_percentage) {
    return {
      shouldSell: true,
      sellPercentage: simulation.take_profit_levels.tp1_sell_percentage,
      reason: `🎯 TP1 reached: ${currentGain.toFixed(2)}% >= ${simulation.take_profit_levels.tp1_percentage}%`
    }
  }

  // Check TP2 (100%) - Sell remaining position
  if (hasTP1 && currentGain >= simulation.take_profit_levels.tp2_percentage) {
    return {
      shouldSell: true,
      sellPercentage: 100,
      reason: `🎯 TP2 reached: ${currentGain.toFixed(2)}% >= ${simulation.take_profit_levels.tp2_percentage}%`
    }
  }

  // Check TP3 (30% after TP1) - Sell remaining position
  if (hasTP1 && simulation.take_profit_levels.tp3_enabled && currentGain <= simulation.take_profit_levels.tp3_percentage) {
    return {
      shouldSell: true,
      sellPercentage: 100,
      reason: `📉 TP3 triggered: ${currentGain.toFixed(2)}% <= ${simulation.take_profit_levels.tp3_percentage}% after TP1`
    }
  }

  // Check max hold time
  const simulationStart = new Date(simulation.simulation_started_at)
  const now = new Date()
  const holdDurationHours = (now.getTime() - simulationStart.getTime()) / (1000 * 60 * 60)

  if (holdDurationHours >= simulation.max_hold_hours) {
    return {
      shouldSell: true,
      sellPercentage: 100,
      reason: `⏰ Max hold time reached: ${holdDurationHours.toFixed(1)}h >= ${simulation.max_hold_hours}h`
    }
  }

  return {
    shouldSell: false,
    sellPercentage: 0,
    reason: ''
  }
}

// Add function to toggle trading mode
async function setTradingMode(isSimulated: boolean, keypairPath?: string): Promise<void> {
  try {
    // Update all active simulations
    const { data: activeSimulations, error: fetchError } = await supabase
      .from(TRACKER_TABLE)
      .select('*')
      .eq('status', 'tracking')
      .not('trading_simulation', 'is', null)

    if (fetchError) {
      throw new Error(`Failed to fetch active simulations: ${fetchError.message}`)
    }

    // Update each simulation's trading mode
    for (const token of activeSimulations || []) {
      if (token.trading_simulation) {
        const simulation = token.trading_simulation as TradingSimulation
        simulation.is_simulated = isSimulated
        simulation.keypair_path = keypairPath

        const { error: updateError } = await supabase
          .from(TRACKER_TABLE)
          .update({
            trading_simulation: simulation
          })
          .eq('id', token.id)

        if (updateError) {
          console.error(`Failed to update trading mode for ${token.token_symbol}:`, updateError)
        } else {
          console.log(`✅ Updated trading mode for ${token.token_symbol}: ${isSimulated ? 'Simulated' : 'Real'} trading`)
        }
      }
    }
  } catch (error) {
    console.error('Failed to set trading mode:', error)
    throw error
  }
}

// Add endpoint to toggle trading mode
export async function PUT(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const secretKey = searchParams.get('key')
    const expectedSecretKey = process.env.TRENDING_TRACKER_SECRET || 'r3l0ads0l-trending'

    if (secretKey !== expectedSecretKey) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { isSimulated, keypairPath } = body

    if (typeof isSimulated !== 'boolean') {
      return NextResponse.json({ error: 'isSimulated must be a boolean' }, { status: 400 })
    }

    if (!isSimulated && !keypairPath && !process.env.TRADING_KEYPAIR_JSON) {
      return NextResponse.json({ error: 'Trading keypair not configured. Provide keypairPath or set TRADING_KEYPAIR_JSON' }, { status: 400 })
    }

    await setTradingMode(isSimulated, keypairPath)

    // Send Discord notification about trading mode change
    if (shouldEnableNotifications()) {
      try {
        const mode = isSimulated ? 'SIMULATION' : 'LIVE TRADING'
        const emoji = isSimulated ? '💻' : '🔥'
        const content = [
          `${emoji} Trading Mode Changed`,
          `Mode: ${mode}`,
          `Keypair: ${keypairPath || 'Not specified'}`,
          `Time: ${new Date().toLocaleString()}`,
          `Status: Successfully activated`
        ].join('\n')

        await fetch(DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content })
        })

        console.log(`✅ Discord notification sent for trading mode change: ${mode}`)
      } catch (discordError) {
        console.error('❌ Failed to send Discord notification for trading mode change:', discordError)
        // Don't fail the operation if Discord fails
      }
    }

    return NextResponse.json({
      success: true,
      mode: isSimulated ? 'simulated' : 'real',
      message: `Successfully switched to ${isSimulated ? 'simulated' : 'real'} trading mode`
    })

  } catch (error) {
    console.error('Error in PUT /api/trending/track:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

async function internalTrackPost(request: NextRequest) {
  const requestStartTime = Date.now()
  const requestId = Math.random().toString(36).substring(7)

  try {
    // Log incoming request
    logTradeOperation('Tracking Request Started', {
      requestId,
      userAgent: request.headers.get('user-agent'),
      source: request.headers.get('user-agent')?.includes('reloadsol-cron-service') ? 'cron' : 'browser'
    })

    // Validate authentication (server-side only)
    const { searchParams } = new URL(request.url)
    const secretKey = searchParams.get('key')
    const expectedSecretKey = process.env.TRENDING_TRACKER_SECRET || 'r3l0ads0l-trending'

    // Check if this is a Vercel cron job (has special headers)
    const isVercelCron = request.headers.get('vercel-cron') === '1' ||
      request.headers.get('user-agent')?.includes('vercel-cron') ||
      process.env.VERCEL === '1' && !secretKey && !request.headers.get('referer')

    // Allow calls from:
    // 1. Vercel cron jobs (internal calls)
    // 2. Localhost in development (no secret needed)
    // 3. Valid secret key (manual/external calls)
    const isDevelopment = process.env.NODE_ENV === 'development'
    const isLocalhost = request.headers.get('host')?.includes('localhost') || request.headers.get('host')?.includes('127.0.0.1')

    if (isVercelCron) {
      console.log('🤖 Vercel cron job detected: allowing combined tracking+summary API call')
    } else if (isDevelopment && isLocalhost && !secretKey) {
      console.log('🔓 Development mode: allowing combined tracking+summary API call without secret key')
    } else if (secretKey !== expectedSecretKey) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Determine if we should run daily summary (runs once per day at ~midnight)
    const currentTime = new Date()
    const lastSummaryCheck = await checkLastSummaryTime()
    const shouldRunSummary = shouldRunDailySummary(currentTime, lastSummaryCheck)

    if (shouldRunSummary) {
      console.log('📊 Running daily summary before tracking update...')
      await runDailySummary(currentTime)
    }

    // Also check if we should run PnL update (once daily at 2 AM UTC)
    const shouldRunPnL = shouldRunPnLUpdate(currentTime)
    if (shouldRunPnL) {
      console.log('💰 Running daily PnL update...')
      await runPnLUpdate()
    }

    console.log('🔍 Starting 5-minute trending token tracking...')

    // Fetch current trending tokens from Jupiter API with fallback & retry
    const TRENDING_URLS = [
      'https://datapi.jup.ag/v1/pools/toptrending/1h',
      // 'https://api.jup.ag/v1/pools/toptrending/1h'
    ]

    let response: Response | null = null

    for (const url of TRENDING_URLS) {
      try {
        response = await fetch(url, {
          headers: {
            accept: 'application/json',
            'cache-control': 'no-cache',
            'user-agent': 'reloadsol-bot/1.0 (+https://reloadsol.xyz)'
          }
        })

        if (response.ok) break

        if (response.status === 403 || response.status === 429) {
          console.warn(`Trending track API ${url} responded with ${response.status}. Retrying next mirror...`)
          await new Promise(res => setTimeout(res, 500))
          continue
        }

        throw new Error(`Jupiter API responded with status: ${response.status}`)
      } catch (err) {
        console.error(`Error fetching trending tokens from ${url}:`, err)
      }
    }

    if (!response || !response.ok) {
      throw new Error('All Jupiter trending API endpoints failed')
    }

    const data = await response.json() as JupiterResponse

    // Filter tokens using quality criteria
    const filteredTokens = data.pools
      .filter(pool =>
        // 1. Avoid total crashes (> 40% drops are ignored)
        (pool.baseAsset.stats5m?.priceChange ?? 0) > -0.40 &&
        // 2. Quality filters
        pool.baseAsset.organicScore >= 65 &&
        pool.baseAsset.mcap > 300_000 &&
        pool.baseAsset.mcap < 2_000_000 &&
        // 3. Filter > 25% Holders 
        pool.baseAsset.audit.topHoldersPercentage < 25
      )
      .map(pool => ({
        token_address: pool.baseAsset.id,
        token_symbol: pool.baseAsset.symbol,
        token_name: pool.baseAsset.name,
        logo_url: pool.baseAsset.icon,
        current_price: pool.baseAsset.usdPrice,
        organic_score: pool.baseAsset.organicScore,
        market_cap: pool.baseAsset.mcap,
        volume_1h: pool.baseAsset.stats1h.buyVolume,
        change_1h: (pool.baseAsset.stats1h?.priceChange ?? 0) / 100,
        change_5m: (pool.baseAsset.stats5m?.priceChange ?? 0) / 100
      }))

    console.log(`📊 Found ${filteredTokens.length} trending tokens to process`)

    // Get currently tracked and waiting tokens
    const { data: trackedTokens, error: fetchError } = await supabase
      .from(TRACKER_TABLE)
      .select(
        `id, token_address, token_symbol, token_name, logo_url,
         initial_price_usd, last_price_usd, peak_price_usd,
         current_gain_percentage, peak_gain_percentage, status,
         organic_score, market_cap, volume_1h,
         tracking_started_at, updated_at,
         trading_simulation, price_history,
         waiting_started_at, waiting_initial_price`
      )
      .in('status', ['tracking', 'waiting'])

    // Check for manual sells before processing new tokens
    if (trackedTokens && trackedTokens.length > 0) {
      try {
        await checkForManualSells(trackedTokens as TrackedToken[])
      } catch (error) {
        console.error('❌ Error checking for manual sells:', error)
        // Continue processing even if manual sell detection fails
      }
    }

    if (fetchError) {
      throw new Error(`Failed to fetch tracked tokens: ${fetchError.message}`)
    }

    const trackedTokensMap = new Map<string, TrackedToken>()
    trackedTokens?.forEach(token => {
      trackedTokensMap.set(token.token_address, token as TrackedToken)
    })

    let newTokensAdded = 0
    let tokensUpdated = 0
    let tokensLost = 0
    let updatesPromises: Promise<any>[] = []

    // at the top of POST handler, just after you fetch `trackedTokens`
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const purgeIds = trackedTokens
      ?.filter(t => t.status !== 'tracking' && new Date(t.updated_at) < cutoff24h)
      .map(t => t.id)

    if (purgeIds?.length) {
      await supabase.from(TRACKER_TABLE).delete().in('id', purgeIds)
    }

    // Process each trending token
    for (const token of filteredTokens) {
      const existingToken = trackedTokensMap.get(token.token_address)

      if (!existingToken) {
        // Check if token exists in database with ANY status (not just tracking)
        const { data: existingAnyStatus } = await supabase
          .from(TRACKER_TABLE)
          .select('*') // Select all fields instead of just 'id'
          .eq('token_address', token.token_address)
          .eq('token_symbol', token.token_symbol)
          .single()

        if (existingAnyStatus) {
          // Enhanced logging with detailed token information
          const timeSinceTracking = existingAnyStatus.tracking_started_at
            ? Math.round((Date.now() - new Date(existingAnyStatus.tracking_started_at).getTime()) / (1000 * 60 * 60 * 24) * 100) / 100
            : 'Unknown'

          const timeSinceStatusChange = existingAnyStatus.status_changed_at
            ? Math.round((Date.now() - new Date(existingAnyStatus.status_changed_at).getTime()) / (1000 * 60 * 60 * 24) * 100) / 100
            : 'N/A'

          const lastUpdateTime = existingAnyStatus.updated_at
            ? Math.round((Date.now() - new Date(existingAnyStatus.updated_at).getTime()) / (1000 * 60)) / 100
            : 'Unknown'

          console.warn(`⏭️ Token ${token.token_symbol} already exists in database. Skipping duplicate.`)
          console.log(`📊 ${token.token_symbol} Details:`, {
            status: existingAnyStatus.status,
            initial_price: `$${existingAnyStatus.initial_price_usd?.toFixed(6) || 'N/A'}`,
            last_price: `$${existingAnyStatus.last_price_usd?.toFixed(6) || 'N/A'}`,
            peak_price: `$${existingAnyStatus.peak_price_usd?.toFixed(6) || 'N/A'}`,
            current_pnl: `${existingAnyStatus.current_gain_percentage?.toFixed(2) || '0.00'}%`,
            peak_pnl: `${existingAnyStatus.peak_gain_percentage?.toFixed(2) || '0.00'}%`,
            tracking_started: `${timeSinceTracking} days ago`,
            status_changed: existingAnyStatus.status_changed_at ? `${timeSinceStatusChange} days ago` : 'Never',
            last_updated: `${lastUpdateTime} minutes ago`,
            current_vs_peak: existingAnyStatus.peak_price_usd && existingAnyStatus.last_price_usd
              ? `${((existingAnyStatus.last_price_usd / existingAnyStatus.peak_price_usd - 1) * 100).toFixed(2)}%`
              : 'N/A'
          })

          // Send Discord notification for skipped token
          await sendSkippedTokenDiscord({
            tokenSymbol: token.token_symbol,
            tokenAddress: token.token_address,
            currentPriceAPI: token.current_price,
            existingTokenData: {
              status: existingAnyStatus.status,
              initial_price_usd: existingAnyStatus.initial_price_usd,
              last_price_usd: existingAnyStatus.last_price_usd,
              peak_price_usd: existingAnyStatus.peak_price_usd,
              current_gain_percentage: existingAnyStatus.current_gain_percentage,
              peak_gain_percentage: existingAnyStatus.peak_gain_percentage,
              tracking_started_at: existingAnyStatus.tracking_started_at,
              status_changed_at: existingAnyStatus.status_changed_at,
              updated_at: existingAnyStatus.updated_at
            }
          })

          continue
        }

        // Enhanced duplicate check before starting new token tracking
        const duplicateCheck = await performEnhancedDuplicateCheck(token.token_address, token.token_symbol, token.current_price)
        if (!duplicateCheck.canPurchase) {
          console.warn(`🚫 Skipping ${token.token_symbol} due to duplicate prevention: ${duplicateCheck.reason}`)
          continue
        }

        // Log if this is a re-buy scenario
        if (duplicateCheck.isRebuy) {
          console.log(`🔄 Re-buy scenario detected for ${token.token_symbol} - will use ${(duplicateCheck.rebuyMultiplier! * 100)}% of normal buy amount`)
        }

        // Check if token has pumped more than 120% in the last hour
        const hourlyPumpPercentage = (token.change_1h || 0) * 100
        const shouldWaitForDip = hourlyPumpPercentage > 120

        if (shouldWaitForDip) {
          console.log(`🚀 Token ${token.token_symbol} pumped ${hourlyPumpPercentage.toFixed(1)}% - adding to waiting queue`)
        } else {
          console.log(`📈 Token ${token.token_symbol} change ${hourlyPumpPercentage.toFixed(1)}% - proceeding with immediate tracking`)
        }

        if (shouldWaitForDip) {
          // Route highly pumped tokens to waiting system
          const tokenId = (existingAnyStatus as any)?.id || `wait_${token.token_address}_${Date.now()}`

          // Create initial price history record
          const initialPriceRecord: PriceRecord = {
            timestamp: new Date().toISOString(),
            price_usd: token.current_price,
            volume: token.volume_1h
          }

          const currentTime = new Date().toISOString()

          updatesPromises.push(
            (async () => {
              try {
                const { error } = await supabase
                  .from(TRACKER_TABLE)
                  .upsert({
                    id: tokenId,
                    token_address: token.token_address,
                    token_symbol: token.token_symbol,
                    token_name: token.token_name,
                    logo_url: token.logo_url,
                    initial_price_usd: token.current_price,
                    last_price_usd: token.current_price,
                    peak_price_usd: 0,
                    current_gain_percentage: 0,
                    peak_gain_percentage: 0,
                    status: 'waiting',
                    organic_score: token.organic_score,
                    market_cap: token.market_cap,
                    volume_1h: token.volume_1h,
                    tracking_started_at: currentTime,
                    trading_simulation: null, // No simulation until we buy
                    price_history: [initialPriceRecord],
                    // New waiting system fields
                    waiting_started_at: currentTime,
                    waiting_initial_price: token.current_price
                  }, {
                    onConflict: 'token_address',
                    ignoreDuplicates: false
                  })

                if (error) {
                  logTradeOperation('Database Upsert Error', {
                    tokenSymbol: token.token_symbol,
                    tokenAddress: token.token_address,
                    errorCode: error.code,
                    errorMessage: error.message,
                    isRestart: !!existingAnyStatus
                  }, new Error(error.message))
                  throw error
                }
              } catch (err) {
                console.error(`❌ Failed to upsert waiting token ${token.token_symbol}:`, err)
                // Don't re-throw to prevent unhandled rejection - let Promise.allSettled handle it
                return { success: false, error: err, tokenSymbol: token.token_symbol }
              }
              return { success: true, tokenSymbol: token.token_symbol }
            })()
          )

          newTokensAdded++
          console.log(`⏳ Adding pumped token to waiting queue: ${token.token_symbol} (${token.token_address}) - waiting for 15% dip`)

        } else {
          // Proceed with immediate buy and tracking for tokens that haven't pumped excessively
          const tokenId = (existingAnyStatus as any)?.id || `track_${token.token_address}_${Date.now()}`

          // Perform buy operation for new tokens (simulation or real trading)
          let tradingSimulation: TradingSimulation | null = null
          try {
            // Check if real trading mode is activated by looking at existing tokens
            let isRealTradingActive = false
            let keypairPath: string | undefined = undefined

            // Check if any existing tracked token has real trading enabled
            const existingRealTradeToken = trackedTokens?.find(t =>
              t.trading_simulation && !t.trading_simulation.is_simulated
            )

            if (existingRealTradeToken?.trading_simulation) {
              isRealTradingActive = true
              keypairPath = existingRealTradeToken.trading_simulation.keypair_path
              console.log(`🔥 Real trading mode detected - new token ${token.token_symbol} will use REAL trading`)
            } else {
              console.log(`💻 Simulation mode - new token ${token.token_symbol} will use simulation`)
            }

            // Create initial simulation configuration (use detected trading mode)
            const initialSimulation: TradingSimulation = {
              token_address: token.token_address,
              token_symbol: token.token_symbol,
              simulation_started_at: new Date().toISOString(),
              buy_operation: null,
              sell_operations: [],
              current_status: 'buying',
              remaining_token_amount: '0',
              initial_token_amount: '0',
              is_simulated: !isRealTradingActive, // Use detected trading mode
              keypair_path: keypairPath,
              take_profit_levels: {
                tp1_percentage: 60,
                tp1_sell_percentage: 80,
                tp2_percentage: 100,
                tp3_percentage: 30,
                tp3_enabled: false
              },
              stop_loss_percentage: -50,
              max_hold_hours: 24,
              final_result: null
            }

            // Perform buy operation using the unified system
            const buyOperation = await performBuyOperation(token, initialSimulation)

            if (buyOperation) {
              initialSimulation.buy_operation = buyOperation
              initialSimulation.current_status = 'holding'
              initialSimulation.remaining_token_amount = buyOperation.token_amount_received
              initialSimulation.initial_token_amount = buyOperation.token_amount_received
              tradingSimulation = initialSimulation

              console.log(`💰 Buy operation completed for ${token.token_symbol}: ${buyOperation.token_amount_received} tokens (${initialSimulation.is_simulated ? 'simulated' : 'real'})`)
            } else {
              console.warn(`❌ Buy operation failed for ${token.token_symbol}`)
            }
          } catch (error) {
            console.error(`❌ Buy operation error for ${token.token_symbol}:`, error)
          }

          // Create initial price history record for new token
          const initialPriceRecord: PriceRecord = {
            timestamp: new Date().toISOString(),
            price_usd: token.current_price,
            volume: token.volume_1h
          }

          updatesPromises.push(
            (async () => {
              try {
                // Use UPSERT to handle race conditions and duplicate token addresses
                const { error } = await supabase
                  .from(TRACKER_TABLE)
                  .upsert({
                    id: tokenId,
                    token_address: token.token_address,
                    token_symbol: token.token_symbol,
                    token_name: token.token_name,
                    logo_url: token.logo_url,
                    initial_price_usd: token.current_price,
                    last_price_usd: token.current_price,
                    peak_price_usd: 0,
                    current_gain_percentage: 0,
                    peak_gain_percentage: 0,
                    status: 'tracking',
                    organic_score: token.organic_score,
                    market_cap: token.market_cap,
                    volume_1h: token.volume_1h,
                    tracking_started_at: new Date().toISOString(),
                    trading_simulation: tradingSimulation,
                    price_history: [initialPriceRecord]
                  }, {
                    onConflict: 'token_address',
                    ignoreDuplicates: false
                  })

                if (error) {
                  logTradeOperation('Database Upsert Error', {
                    tokenSymbol: token.token_symbol,
                    tokenAddress: token.token_address,
                    errorCode: error.code,
                    errorMessage: error.message,
                    isRestart: !!existingAnyStatus
                  }, new Error(error.message))
                  throw error
                }

                // Send Discord notification for new token detection (MOVED BEFORE RETURN)
                if (shouldEnableNotifications()) {
                  try {
                    await sendNewTokenDetectionDiscord({
                      tokenAddress: token.token_address,
                      tokenSymbol: token.token_symbol,
                      tokenName: token.token_name,
                      currentPrice: token.current_price,
                      marketCap: token.market_cap,
                      organicScore: token.organic_score,
                      volume1h: token.volume_1h,
                      isRealTrading: tradingSimulation?.is_simulated === false
                    })
                  } catch (discordError) {
                    console.error('❌ Failed to send new token Discord notification:', discordError)
                    // Don't fail the operation if Discord fails
                  }
                }

                return { success: true, tokenSymbol: token.token_symbol }
              } catch (err) {
                console.error(`❌ Failed to upsert token ${token.token_symbol}:`, err)
                // Don't re-throw to prevent unhandled rejection - let Promise.allSettled handle it
                return { success: false, error: err, tokenSymbol: token.token_symbol }
              }
            })()
          )

          newTokensAdded++
          console.log(`✅ Adding new token to immediate tracking: ${token.token_symbol} (${token.token_address})`)
        }
      } else {
        // Validate prices
        if (token.current_price <= 0) {
          console.warn(`Invalid current price for ${token.token_symbol}:`, token.current_price)
          continue
        }

        // Handle waiting tokens (check for 15% dip trigger or 1-hour timeout)
        if (existingToken.status === 'waiting') {
          const waitingStartTime = new Date(existingToken.waiting_started_at!)
          const currentTime = new Date()
          const waitingDurationHours = (currentTime.getTime() - waitingStartTime.getTime()) / (1000 * 60 * 60)

          // Check for 1-hour timeout
          if (waitingDurationHours >= 1.0) {
            console.log(`⏰ Waiting timeout for ${token.token_symbol} after ${waitingDurationHours.toFixed(1)}h - removing from queue`)

            // Remove from waiting queue (mark as skipped due to timeout)
            updatesPromises.push(
              (async () => {
                const { error } = await supabase
                  .from(TRACKER_TABLE)
                  .update({
                    status: 'skipped',
                    status_changed_at: currentTime.toISOString(),
                    last_price_usd: token.current_price,
                    current_gain_percentage: calculateGainPercentage(token.current_price, existingToken.waiting_initial_price!)
                  })
                  .eq('id', existingToken.id)
                if (error) throw error
              })()
            )
            continue
          }

          // Calculate dip percentage from waiting initial price
          const dipFromWaitingStart = calculateGainPercentage(token.current_price, existingToken.waiting_initial_price!)

          console.log(`📊 Waiting token ${token.token_symbol}: ${dipFromWaitingStart.toFixed(2)}% change (waiting ${waitingDurationHours.toFixed(1)}h)`)

          // Check for 15% dip trigger
          if (dipFromWaitingStart <= -15.0) {
            console.log(`🎯 15% dip detected for ${token.token_symbol}! Converting from waiting to tracking status`)

            // Execute buy operation and convert to tracking
            try {
              // Check if real trading mode is activated by looking at existing tokens
              let isRealTradingActive = false
              let keypairPath: string | undefined = undefined

              // Check if any existing tracked token has real trading enabled
              const existingRealTradeToken = trackedTokens?.find(t =>
                t.trading_simulation && !t.trading_simulation.is_simulated
              )

              if (existingRealTradeToken?.trading_simulation) {
                isRealTradingActive = true
                keypairPath = existingRealTradeToken.trading_simulation.keypair_path
                console.log(`🔥 Real trading mode detected - ${token.token_symbol} will use REAL trading`)
              } else {
                console.log(`💻 Simulation mode - ${token.token_symbol} will use simulation`)
              }

              // Create initial simulation configuration (use detected trading mode)
              const initialSimulation: TradingSimulation = {
                token_address: token.token_address,
                token_symbol: token.token_symbol,
                simulation_started_at: currentTime.toISOString(),
                buy_operation: null,
                sell_operations: [],
                current_status: 'buying',
                remaining_token_amount: '0',
                initial_token_amount: '0',
                is_simulated: !isRealTradingActive, // Use detected trading mode
                keypair_path: keypairPath,
                take_profit_levels: {
                  tp1_percentage: 60,
                  tp1_sell_percentage: 95,
                  tp2_percentage: 100,
                  tp3_percentage: 30,
                  tp3_enabled: false
                },
                stop_loss_percentage: -50,
                max_hold_hours: 24,
                final_result: null
              }

              // Perform buy operation using the unified system
              const buyOperation = await performBuyOperation(token, initialSimulation)

              if (buyOperation) {
                initialSimulation.buy_operation = buyOperation
                initialSimulation.current_status = 'holding'
                initialSimulation.remaining_token_amount = buyOperation.token_amount_received
                initialSimulation.initial_token_amount = buyOperation.token_amount_received

                console.log(`💰 Buy operation completed for ${token.token_symbol}: ${buyOperation.token_amount_received} tokens (${initialSimulation.is_simulated ? 'simulated' : 'real'})`)

                // Update token status to tracking with buy simulation
                updatesPromises.push(
                  (async () => {
                    const { error } = await supabase
                      .from(TRACKER_TABLE)
                      .update({
                        status: 'tracking',
                        status_changed_at: currentTime.toISOString(),
                        initial_price_usd: token.current_price, // Update initial price to dip price
                        last_price_usd: token.current_price,
                        peak_price_usd: token.current_price,
                        current_gain_percentage: 0, // Reset gain calculation from new buy price
                        peak_gain_percentage: 0,
                        trading_simulation: initialSimulation
                      })
                      .eq('id', existingToken.id)
                    if (error) throw error
                  })()
                )

                // Send Discord notification for successful dip buy
                if (shouldEnableNotifications()) {
                  try {
                    await sendNewTokenDetectionDiscord({
                      tokenAddress: token.token_address,
                      tokenSymbol: token.token_symbol,
                      tokenName: token.token_name,
                      currentPrice: token.current_price,
                      marketCap: token.market_cap,
                      organicScore: token.organic_score,
                      volume1h: token.volume_1h,
                      isRealTrading: !initialSimulation.is_simulated
                    })
                  } catch (discordError) {
                    console.error('❌ Failed to send dip buy Discord notification:', discordError)
                  }
                }

                tokensUpdated++
                console.log(`✅ ${token.token_symbol} converted from waiting to tracking after 15% dip`)
              } else {
                console.warn(`❌ Buy operation failed for waiting token ${token.token_symbol}`)
                // Keep in waiting status for next attempt
                updatesPromises.push(
                  (async () => {
                    const { error } = await supabase
                      .from(TRACKER_TABLE)
                      .update({
                        last_price_usd: token.current_price
                      })
                      .eq('id', existingToken.id)
                    if (error) throw error
                  })()
                )
              }
            } catch (error) {
              console.error(`❌ Error converting waiting token ${token.token_symbol} to tracking:`, error)
              // Keep in waiting status for next attempt
              updatesPromises.push(
                (async () => {
                  const { error } = await supabase
                    .from(TRACKER_TABLE)
                    .update({
                      last_price_usd: token.current_price
                    })
                    .eq('id', existingToken.id)
                  if (error) throw error
                })()
              )
            }
            continue
          } else {
            // Still waiting - just update price
            updatesPromises.push(
              (async () => {
                const { error } = await supabase
                  .from(TRACKER_TABLE)
                  .update({
                    last_price_usd: token.current_price,
                    organic_score: token.organic_score,
                    market_cap: token.market_cap,
                    volume_1h: token.volume_1h
                  })
                  .eq('id', existingToken.id)
                if (error) throw error
              })()
            )
            continue
          }
        }

        // Calculate current gain for tracking tokens
        const currentGain = calculateGainPercentage(token.current_price, existingToken.initial_price_usd)

        // Only update peak price and gain if current price is higher than existing peak
        const newPeakPrice = calculatePeakPrice(token.current_price, existingToken.peak_price_usd)
        const peakGain = newPeakPrice > existingToken.peak_price_usd ?
          calculateGainPercentage(newPeakPrice, existingToken.initial_price_usd) :
          existingToken.peak_gain_percentage

        // Store price tracking data for analysis
        const priceTracking: PriceTracking = {
          initialPrice: existingToken.initial_price_usd,
          currentPrice: token.current_price,
          peakPrice: newPeakPrice,
          currentGain,
          peakGain,
          lastUpdated: new Date().toISOString()
        }

        // Check if token has dropped more than 50% from initial price (original loss condition)
        const isLost = currentGain <= -50

        // Existing staleness check
        const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
        const lastPriceUpdate = new Date(existingToken.updated_at)
        const isStaleData = lastPriceUpdate < twoWeeksAgo

        // New tracking age check
        const maxTrackingDays = process.env.MAX_TRACKING_DAYS ? parseInt(process.env.MAX_TRACKING_DAYS) : 3;
        const trackingStart = new Date(existingToken.tracking_started_at);
        const trackingAgeDays = (Date.now() - trackingStart.getTime()) / (1000 * 60 * 60 * 24);
        const isTooOld = trackingAgeDays > maxTrackingDays && existingToken.status === 'tracking';

        if (isStaleData || isTooOld) {
          // Mark as stopped due to staleness or age
          updatesPromises.push(
            (async () => {
              const { error } = await supabase
                .from(TRACKER_TABLE)
                .update({
                  status: 'stopped',
                  status_changed_at: new Date().toISOString(),
                  last_price_usd: token.current_price,
                  current_gain_percentage: currentGain,
                  peak_gain_percentage: peakGain,
                  organic_score: token.organic_score,
                  market_cap: token.market_cap,
                  volume_1h: token.volume_1h
                })
                .eq('id', existingToken.id)
              if (error) throw error
            })()
          )

          const reason = isStaleData ? 'stale data' : 'tracking age exceeded';
          console.log(`🛑 Token stopped due to ${reason} (${Math.round(trackingAgeDays)} days): ${token.token_symbol} (${token.token_address})`)
          continue // Skip further processing for this token
        }

        // Check if trading simulation should sell
        let shouldSell = false
        let sellOperation = null

        if (existingToken.trading_simulation && existingToken.trading_simulation.current_status === 'holding') {
          const sellDecision = shouldSellToken(existingToken, existingToken.trading_simulation)

          if (sellDecision.shouldSell) {
            console.log(sellDecision.reason)

            // Perform sell simulation with the specified percentage
            const sellOperation = await performSellOperation(
              {
                ...token,
                current_price: token.current_price
              },
              existingToken.trading_simulation,
              sellDecision.sellPercentage
            )

            if (sellOperation) {
              try {
                // Calculate gains using our helper function
                const finalGain = calculateGainPercentage(token.current_price, existingToken.initial_price_usd)

                // Calculate hold duration
                const simulationStart = new Date(existingToken.trading_simulation.simulation_started_at)
                const now = new Date()
                const holdDurationHours = (now.getTime() - simulationStart.getTime()) / (1000 * 60 * 60)

                // Set final gain and hold duration on sell operation
                sellOperation.final_gain_percentage = finalGain
                sellOperation.hold_duration_hours = holdDurationHours

                // Add sell operation to the simulation
                existingToken.trading_simulation.sell_operations.push(sellOperation)

                // Check if position is fully closed (100% sell or remaining tokens ~ 0)
                const remainingTokens = parseFloat(existingToken.trading_simulation.remaining_token_amount || '0')
                const isPositionClosed = sellDecision.sellPercentage === 100 || remainingTokens < 1000 // Less than 0.001 tokens remaining

                if (isPositionClosed) {
                  // Update simulation status to completed
                  existingToken.trading_simulation.current_status = 'completed'
                  existingToken.trading_simulation.remaining_token_amount = '0'

                  // Calculate final result
                  const buyOperation = existingToken.trading_simulation.buy_operation
                  if (buyOperation) {
                    const totalSolReceived = existingToken.trading_simulation.sell_operations.reduce(
                      (total, op) => total + (parseFloat(op.sol_received) / 1e9), 0
                    )
                    const totalSolGain = totalSolReceived - buyOperation.buy_amount_sol

                    existingToken.trading_simulation.final_result = {
                      success: finalGain > 0,
                      total_gain_percentage: finalGain,
                      total_gain_sol: totalSolGain,
                      buy_price_usd: buyOperation.buy_price_usd,
                      sell_price_usd: token.current_price,
                      hold_duration_hours: holdDurationHours,
                      best_buy_config: buyOperation.best_buy_config,
                      best_sell_configs: existingToken.trading_simulation.sell_operations.map(op => op.best_sell_config)
                    }
                  }
                }

                // Log sell operation details
                logTradeOperation('Sell Operation', {
                  requestId,
                  tokenSymbol: token.token_symbol,
                  finalGain,
                  sellPercentage: sellDecision.sellPercentage,
                  isPositionClosed,
                  operationType: existingToken.trading_simulation.current_status
                })

                // Send Discord notification if enabled
                if (shouldEnableNotifications()) {
                  const bestCfg = sellOperation.best_sell_config
                  const notificationStatus = getNotificationStatus(existingToken.trading_simulation.current_status)

                  await sendTradeAlertDiscord({
                    tokenSymbol: token.token_symbol,
                    status: notificationStatus,
                    isSimulated: existingToken.trading_simulation.is_simulated,
                    currentGain: finalGain,
                    peakGain: existingToken.peak_gain_percentage,
                    priceUsd: token.current_price,
                    provider: bestCfg.provider,
                    rpcUsed: bestCfg.rpc_used,
                    responseTime: bestCfg.response_time
                  }).catch(error => {
                    // Log Discord error but don't fail the operation
                    logTradeOperation('Discord Notification Failed', {
                      requestId,
                      tokenSymbol: token.token_symbol,
                      finalGain
                    }, error)
                  })
                }

                // Log successful completion
                logTradeOperation('Tracking Request Completed', {
                  requestId,
                  duration: Date.now() - requestStartTime,
                  tokenSymbol: token.token_symbol,
                  status: 'success'
                })
              } catch (error) {
                // Log sell operation error
                logTradeOperation('Sell Operation Error', {
                  requestId,
                  tokenSymbol: token.token_symbol,
                  operationType: existingToken.trading_simulation.current_status
                }, error as Error)

                // Continue processing other tokens
                console.error('Error in sell operation:', error)
              }
            }
          }
        }

        // Create new price record for history
        const newPriceRecord: PriceRecord = {
          timestamp: new Date().toISOString(),
          price_usd: token.current_price,
          volume: token.volume_1h
        }

        // Update price history (keep last 24 hours, max 288 records for 5-minute intervals)
        const existingPriceHistory = existingToken.price_history || []
        const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000) // 24 hours ago

        // Filter old records and add new one
        const updatedPriceHistory = [
          ...existingPriceHistory.filter(record => new Date(record.timestamp) > cutoffTime),
          newPriceRecord
        ].slice(-288) // Keep max 288 records (24h * 12 records per hour)

        if (isLost && existingToken.status === 'tracking') {
          // Mark as lost (original logic)
          updatesPromises.push(
            (async () => {
              const { error } = await supabase
                .from(TRACKER_TABLE)
                .update({
                  last_price_usd: token.current_price,
                  peak_price_usd: newPeakPrice,
                  current_gain_percentage: currentGain,
                  peak_gain_percentage: peakGain,
                  status: 'lost',
                  status_changed_at: new Date().toISOString(),
                  organic_score: token.organic_score,
                  market_cap: token.market_cap,
                  volume_1h: token.volume_1h,
                  trading_simulation: existingToken.trading_simulation,
                  price_history: updatedPriceHistory
                })
                .eq('id', existingToken.id)
              if (error) throw error
            })()
          )

          tokensLost++
          console.log(`❌ Token lost (${currentGain.toFixed(2)}%): ${token.token_symbol} (${token.token_address})`)
        } else if (existingToken.status === 'tracking') {
          // Update tracking token with new price data and simulation results
          updatesPromises.push(
            (async () => {
              const { error } = await supabase
                .from(TRACKER_TABLE)
                .update({
                  last_price_usd: token.current_price,
                  peak_price_usd: newPeakPrice,
                  current_gain_percentage: currentGain,
                  peak_gain_percentage: peakGain,
                  organic_score: token.organic_score,
                  market_cap: token.market_cap,
                  volume_1h: token.volume_1h,
                  trading_simulation: existingToken.trading_simulation,
                  price_history: updatedPriceHistory
                })
                .eq('id', existingToken.id)
              if (error) throw error
            })()
          )

          tokensUpdated++
          if (currentGain > 10) {
            console.log(`📈 Token performing well (${currentGain.toFixed(2)}%): ${token.token_symbol}`)
          }

          if (shouldSell && sellOperation) {
            console.log(`🎯 Token sold via simulation (${currentGain.toFixed(2)}%): ${token.token_symbol}`)
          }
        }
      }
    }

    // Execute all updates in parallel
    const results = await Promise.allSettled(updatesPromises)
    const rejectedPromises = results.filter(result => result.status === 'rejected')
    const fulfilledResults = results.filter(result => result.status === 'fulfilled').map(result => result.value)
    const failedOperations = fulfilledResults.filter(result => result && typeof result === 'object' && !result.success)

    const totalFailures = rejectedPromises.length + failedOperations.length

    if (totalFailures > 0) {
      console.error(`⚠️ ${totalFailures} updates failed:`, {
        rejectedPromises: rejectedPromises.length,
        failedOperations: failedOperations.length,
        rejectedReasons: rejectedPromises.map(r => r.reason),
        failedTokens: failedOperations.map(op => op.tokenSymbol)
      })
    }

    // Get updated statistics
    const { data: currentStats, error: statsError } = await supabase
      .from(TRACKER_TABLE)
      .select('status')

    if (statsError) {
      console.error('Failed to fetch current stats:', statsError)
    }

    const stats = {
      waiting: currentStats?.filter(t => t.status === 'waiting').length || 0,
      tracking: currentStats?.filter(t => t.status === 'tracking').length || 0,
      won: currentStats?.filter(t => t.status === 'won').length || 0,
      lost: currentStats?.filter(t => t.status === 'lost').length || 0,
      skipped: currentStats?.filter(t => t.status === 'skipped').length || 0,
      stopped: currentStats?.filter(t => t.status === 'stopped').length || 0
    }

    const summary = {
      success: true,
      timestamp: new Date().toISOString(),
      processed: filteredTokens.length,
      new_tokens_added: newTokensAdded,
      tokens_updated: tokensUpdated,
      tokens_lost: tokensLost,
      failed_updates: totalFailures,
      current_stats: stats,
      message: `Tracked ${filteredTokens.length} tokens: ${newTokensAdded} new, ${tokensUpdated} updated, ${tokensLost} lost`
    }

    if (DEBUG_LOG) {
      console.debug('✅ 5-minute tracking completed:', summary)
    } else {
      console.log(`✅ 5-minute tracking completed: processed ${summary.processed} tokens; new ${summary.new_tokens_added}, updated ${summary.tokens_updated}`)
    }

    // Set a timestamp for cache invalidation (could be used by other APIs)
    const headers: Record<string, string> = {
      'X-Data-Updated': new Date().toISOString(),
      'Cache-Control': 'no-cache' // Track route should never be cached
    }

    return NextResponse.json(summary, {
      status: 200,
      headers
    })

  } catch (error) {
    // Log complete request failure
    logTradeOperation('Tracking Request Failed', {
      requestId,
      duration: Date.now() - requestStartTime,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, error as Error)

    return NextResponse.json({
      error: 'Failed to track trending tokens',
      message: error instanceof Error ? error.message : 'Unknown error',
      requestId,
      timestamp: new Date().toISOString()
    }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  return internalTrackPost(request)
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const tokenAddress = searchParams.get('token')

    if (!tokenAddress) {
      return NextResponse.json({
        error: 'Token address is required',
        example: '/api/trending/track?token=TOKEN_ADDRESS'
      }, { status: 400 })
    }

    // Get token data with trade comparison
    const { data: token, error } = await supabase
      .from(TRACKER_TABLE)
      .select('*')
      .eq('token_address', tokenAddress)
      .single()

    if (error || !token) {
      return NextResponse.json({
        error: 'Token not found',
        token_address: tokenAddress
      }, { status: 404 })
    }

    return NextResponse.json({
      success: true,
      token: {
        id: token.id,
        token_address: token.token_address,
        token_symbol: token.token_symbol,
        token_name: token.token_name,
        logo_url: token.logo_url,
        initial_price_usd: token.initial_price_usd,
        last_price_usd: token.last_price_usd,
        peak_price_usd: token.peak_price_usd,
        current_gain_percentage: token.current_gain_percentage,
        peak_gain_percentage: token.peak_gain_percentage,
        status: token.status,
        organic_score: token.organic_score,
        market_cap: token.market_cap,
        volume_1h: token.volume_1h,
        tracking_started_at: token.tracking_started_at,
        status_changed_at: token.status_changed_at,
        trade_comparison_data: token.trade_comparison_data,
        trading_simulation: token.trading_simulation,
        price_history: token.price_history || []
      },
      timestamp: new Date().toISOString()
    })

  } catch (error) {
    console.error('❌ Error retrieving token trade comparison:', error)
    return NextResponse.json({
      error: 'Failed to retrieve token trade comparison',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    }, { status: 500 })
  }
}

// Helper function to determine notification status
function getNotificationStatus(simulationStatus: TradingSimulationStatus): TradeAlertStatus {
  return simulationStatus === 'completed' ? 'completed' : 'partial-sell'
}

// Safety mechanisms and connection management
const MAX_SOL_AT_RISK = parseFloat(process.env.MAX_SOL_AT_RISK || '1.0') // Maximum SOL that can be at risk
const MIN_SOL_BALANCE = parseFloat(process.env.MIN_SOL_BALANCE || '0.1') // Minimum SOL balance to maintain

// Configure duplicate prevention
const TOKEN_PURCHASE_COOLDOWN_HOURS = parseInt(process.env.TOKEN_PURCHASE_COOLDOWN_HOURS || '24') // Hours to wait before re-purchasing same token
const MAX_PURCHASES_PER_TOKEN = parseInt(process.env.MAX_PURCHASES_PER_TOKEN || '2') // Maximum times to purchase same token
const MIN_WALLET_BALANCE_FOR_DUPLICATE_CHECK = 1000 // Minimum token balance to consider "already holding"

// Track active trades to prevent duplicates
const activeTrades = new Set<string>()

// Enhanced duplicate prevention: track recent purchases
const recentPurchases = new Map<string, { count: number, lastPurchase: Date, purchaseDates: Date[] }>()

// Connection management for real trading
let tradingConnection: Connection | null = null
let tradingKeypair: Keypair | null = null
let tradingSigner: ((transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>) | null = null

function initializeTradingConnection(): Connection {
  if (!tradingConnection) {
    // Always use Shyft RPC for real trading as requested
    const shyftRpcUrl = 'https://rpc.shyft.to?api_key=dt_BAV8lwogCz_vn'
    tradingConnection = new Connection(shyftRpcUrl, 'confirmed')
    console.log('🌐 Real trading connection initialized with Shyft RPC')
  }
  return tradingConnection
}

// Add RPC health check for real trading
async function checkRpcHealth(): Promise<{ healthy: boolean, latency?: number, error?: string }> {
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

async function initializeTradingKeypair(keypairPath?: string): Promise<void> {
  if (!tradingKeypair || !tradingSigner) {
    tradingKeypair = loadTradingKeypair(keypairPath)
    tradingSigner = createSignerFromKeypair(tradingKeypair)
    console.log(`🔑 Trading keypair loaded: ${tradingKeypair.publicKey.toBase58()}`)
  }
}

async function checkTradingBalance(): Promise<{ balance: number, canTrade: boolean }> {
  if (!tradingConnection || !tradingKeypair) {
    return { balance: 0, canTrade: false }
  }

  const balance = await tradingConnection.getBalance(tradingKeypair.publicKey)
  const balanceSOL = balance / 1e9
  const canTrade = balanceSOL >= MIN_SOL_BALANCE

  return { balance: balanceSOL, canTrade }
}

async function getTotalSOLAtRisk(): Promise<number> {
  // Fetch only required fields to keep payload light
  const { data: activeRealTrades } = await supabase
    .from(TRACKER_TABLE)
    .select('trading_simulation')
    .eq('status', 'tracking')
    .not('trading_simulation', 'is', null)

  let totalAtRisk = 0

  for (const trade of activeRealTrades || []) {
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

// Enhanced duplicate prevention functions
async function checkWalletHoldings(tokenAddress: string, currentPrice?: number): Promise<{
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
      const { data: completedTokens, error } = await supabase
        .from(TRACKER_TABLE)
        .select('id, token_address, token_symbol, initial_price_usd, trading_simulation, tracking_started_at')
        .eq('token_address', tokenAddress)
        .in('status', ['completed', 'won', 'lost'])
        .not('trading_simulation', 'is', null)
        .order('tracking_started_at', { ascending: false })
        .limit(1) // Get the most recent completed trade

      if (!error && completedTokens && completedTokens.length > 0) {
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

async function checkRecentPurchaseHistory(tokenAddress: string, tokenSymbol: string | null, currentPrice?: number): Promise<{ shouldPrevent: boolean, reason?: string }> {
  try {
    // Check database for recent purchases of this token - changed to 5 minutes
    const cutoffTime = new Date(Date.now() - 5 * 60 * 1000) // 5 minutes instead of hours

    const { data: recentTokens, error } = await supabase
      .from(TRACKER_TABLE)
      .select('id, token_address, token_symbol, tracking_started_at, trading_simulation, status, initial_price_usd')
      .eq('token_address', tokenAddress)
      .gte('tracking_started_at', cutoffTime.toISOString())
      .order('tracking_started_at', { ascending: false })

    if (error) {
      console.error(`❌ Error checking purchase history for ${tokenSymbol}:`, error)
      return { shouldPrevent: false }
    }

    if (!recentTokens || recentTokens.length === 0) {
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

async function performEnhancedDuplicateCheck(tokenAddress: string, tokenSymbol: string | null, currentPrice?: number): Promise<{
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

async function canExecuteRealTrade(buyAmountSOL: number, tokenAddress?: string, tokenSymbol?: string, currentPrice?: number): Promise<{
  canTrade: boolean,
  reason?: string,
  adjustedBuyAmount?: number,
  isRebuy?: boolean
}> {
  // Check if we can execute a real trade
  const { balance, canTrade: hasBalance } = await checkTradingBalance()

  if (!hasBalance) {
    return { canTrade: false, reason: `Insufficient balance: ${balance.toFixed(4)} SOL < ${MIN_SOL_BALANCE} SOL minimum` }
  }

  let adjustedBuyAmount = buyAmountSOL
  let isRebuy = false

  // Enhanced duplicate prevention check
  if (tokenAddress) {
    const duplicateCheck = await performEnhancedDuplicateCheck(tokenAddress, tokenSymbol || null, currentPrice)
    if (!duplicateCheck.canPurchase) {
      return { canTrade: false, reason: duplicateCheck.reason }
    }

    // Adjust buy amount for re-buy scenarios
    if (duplicateCheck.isRebuy && duplicateCheck.rebuyMultiplier) {
      adjustedBuyAmount = buyAmountSOL * duplicateCheck.rebuyMultiplier
      isRebuy = true
      console.log(`🔄 Adjusting buy amount for re-buy: ${buyAmountSOL} SOL → ${adjustedBuyAmount} SOL (${(duplicateCheck.rebuyMultiplier * 100)}%)`)
    }
  }

  const totalAtRisk = await getTotalSOLAtRisk()
  const newTotalAtRisk = totalAtRisk + adjustedBuyAmount

  if (newTotalAtRisk > MAX_SOL_AT_RISK) {
    return { canTrade: false, reason: `Risk limit exceeded: ${newTotalAtRisk.toFixed(4)} SOL > ${MAX_SOL_AT_RISK} SOL maximum` }
  }

  if (balance < adjustedBuyAmount + MIN_SOL_BALANCE) {
    return { canTrade: false, reason: `Insufficient balance for trade: need ${(adjustedBuyAmount + MIN_SOL_BALANCE).toFixed(4)} SOL, have ${balance.toFixed(4)} SOL` }
  }

  return { canTrade: true, adjustedBuyAmount, isRebuy }
}