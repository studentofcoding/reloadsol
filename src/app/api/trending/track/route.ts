import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'
import { supabase } from '@/utils/supabase'
import { compareTradeQuotes, performEnhancedTradeComparison } from '@/utils/trade-comparison'
import { Connection, VersionedTransaction, Keypair } from '@solana/web3.js'
import { getSwapQuote, getSwapTransaction } from '@/utils/jupiter'

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

interface JupiterBaseAsset {
  id: string
  name: string
  symbol: string
  icon: string
  decimals: number
  usdPrice: number
  stats1h: {
    priceChange: number
    numNetBuyers: number
    buyVolume: number
  }
  stats5m: {
    priceChange: number
    numNetBuyers: number | null
    buyVolume: number | null
  }
  mcap: number
  organicScore: number
}

interface JupiterPool {
  id: string
  baseAsset: JupiterBaseAsset
  volume24h: number
  createdAt: string | number
}

interface JupiterResponse {
  pools: JupiterPool[]
}

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
  status: 'tracking' | 'won' | 'lost'
  organic_score: number | null
  market_cap: number | null
  volume_1h: number | null
  volume_5m: number | null
  tracking_started_at: string
  status_changed_at: string | null
  created_at: string
  updated_at: string
  trade_comparison_data?: TradeComparisonResult | null
  trading_simulation?: TradingSimulation | null
  price_history?: PriceRecord[] | null
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
            skipPreflight: false,
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

// Helper function to perform enhanced trade comparison for a token
async function performTradeComparison(token: any): Promise<TradeComparisonResult | null> {
  try {
    console.log(`🚀 Performing enhanced trade comparison for ${token.token_symbol} (${token.token_address})`)
    
    // Use the new enhanced trade comparison function
    const enhancedResult = await performEnhancedTradeComparison(
      token.token_address,
      token.token_symbol,
      0.03 // 0.03 SOL as specified
    )
    
    // Convert enhanced result to the expected TradeComparisonResult format for backward compatibility
    const tradeResult: TradeComparisonResult = {
      token_address: enhancedResult.token_address,
      token_symbol: enhancedResult.token_symbol,
      timestamp: enhancedResult.timestamp,
      buy_amount_sol: enhancedResult.buy_amount_sol,
      comparisons: enhancedResult.configurations,
      best_config: enhancedResult.best_config || {
        slippage: 0,
        provider: 'none',
        token_amount: '0',
        response_time: 0,
        total_fees: 0
      }
    }
    
    console.log(`✅ Enhanced trade comparison completed for ${token.token_symbol}:`, {
      successful_configs: Object.values(enhancedResult.configurations).filter(c => c.success).length,
      best_provider: enhancedResult.best_config?.provider,
      best_rpc: enhancedResult.best_config?.rpc_used,
      provider_performance: Object.entries(enhancedResult.provider_performance)
        .map(([p, perf]) => `${p}: ${perf.success_rate.toFixed(1)}%`)
        .join(', ')
    })
    
    return tradeResult
    
  } catch (error) {
    console.error(`❌ Error performing enhanced trade comparison for ${token.token_symbol}:`, error)
    return null
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

// Unified buy operation (supports both simulation and real trading)
async function performBuyOperation(token: any, simulation: TradingSimulation): Promise<BuyOperation | null> {
  try {
    const isSimulated = simulation.is_simulated
    const operationType = isSimulated ? 'simulation' : 'real trade'
    console.log(`💰 Performing buy ${operationType} for ${token.token_symbol} (${token.token_address})`)
    
    // SOL mint address and trading parameters
    const SOL_MINT = 'So11111111111111111111111111111111111111112'
    const BUY_AMOUNT_SOL = 0.03 // 0.03 SOL per token as specified
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
      
      // Check if we can execute the trade
      const { canTrade, reason } = await canExecuteRealTrade(BUY_AMOUNT_SOL, token.token_address)
      if (!canTrade) {
        throw new Error(`Cannot execute real trade: ${reason}`)
      }
      
      // Mark token as having active trade
      activeTrades.add(token.token_address)
      
      console.log(`🔥 Real trading safety checks passed - RPC healthy (${rpcHealth.latency}ms), sufficient balance`)
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
      rpc_used: bestResult.rpcUsed
    }
    
    // Add signature for real trades
    if (bestResult.signature) {
      (buyOperation as any).signature = bestResult.signature
    }
    
    console.log(`✅ Buy ${operationType} completed for ${token.token_symbol}: ${bestResult.outputAmount} tokens via ${bestResult.provider}${bestResult.signature ? ` (${bestResult.signature})` : ''}`)
    
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
    const PRIORITY_FEE_LAMPORTS = Math.floor(0.001 * 1e9) // 0.001 SOL priority fee
    
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
      const buyAmountSOL = 0.03 // Same as used in buy operation
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
      hold_duration_hours: holdDurationHours
    }
    
    // Add signature for real trades
    if (bestResult.signature) {
      (sellOperation as any).signature = bestResult.signature
    }
    
    // Update simulation's remaining token amount
    simulation.remaining_token_amount = remainingTokens
    
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
    const expectedSecretKey = process.env.TRENDING_TRACKER_SECRET || 'trending-track-secret'
    
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

export async function POST(request: NextRequest) {
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
    const expectedSecretKey = process.env.TRENDING_TRACKER_SECRET || 'trending-track-secret'
    
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
    
    // Fetch current trending tokens from Jupiter API
    const response = await fetch('https://datapi.jup.ag/v1/pools/toptrending/1h', {
      headers: {
        'accept': 'application/json',
        'cache-control': 'no-cache',
      },
    })

    if (!response.ok) {
      throw new Error(`Jupiter API responded with status: ${response.status}`)
    }

    const data = await response.json() as JupiterResponse
    
    // Filter tokens using the same criteria as the main trending API
    const filteredTokens = data.pools
      .filter(pool => 
        pool.baseAsset.stats5m?.priceChange > -40 && // Not dropping more than 40% in 5m
        pool.baseAsset.organicScore >= 70.0 &&
        pool.baseAsset.mcap > 300000 &&
        pool.baseAsset.mcap < 2000000
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

    // Get currently tracked tokens
    const { data: trackedTokens, error: fetchError } = await supabase
      .from(TRACKER_TABLE)
      .select(`id, token_address, token_symbol, token_name, logo_url, initial_price_usd, last_price_usd, peak_price_usd, current_gain_percentage, peak_gain_percentage, status, organic_score, market_cap, volume_1h, tracking_started_at, trading_simulation, price_history`)
      .eq('status', 'tracking')

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

    // Process each trending token
    for (const token of filteredTokens) {
      const existingToken = trackedTokensMap.get(token.token_address)
      
      if (!existingToken) {
        // New token - start tracking it and perform trading simulation
        const tokenId = `track_${token.token_address}_${Date.now()}`
        
        // Perform trade comparison for new tokens
        let tradeComparisonData = null
        try {
          tradeComparisonData = await performTradeComparison(token)
          console.log(`📊 Trade comparison for new token ${token.token_symbol}:`, {
            best_config: tradeComparisonData?.best_config,
            successful_comparisons: Object.values(tradeComparisonData?.comparisons || {}).filter((c: any) => c.success).length
          })
        } catch (error) {
          console.error(`❌ Trade comparison failed for ${token.token_symbol}:`, error)
        }
        
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
              tp1_percentage: 80,
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
            console.log(`❌ Buy operation failed for ${token.token_symbol}`)
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
            const { error } = await supabase
              .from(TRACKER_TABLE)
              .insert({
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
                trade_comparison_data: tradeComparisonData,
                trading_simulation: tradingSimulation,
                price_history: [initialPriceRecord]
              })
            if (error) throw error
            
            // Send Discord notification for new token detection
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
                  isRealTrading: tradingSimulation ? !tradingSimulation.is_simulated : false
                })
              } catch (discordError) {
                console.error('❌ Failed to send new token Discord notification:', discordError)
                // Don't fail the operation if Discord fails
              }
            }
          })()
        )
        
        newTokensAdded++
        console.log(`✅ Adding new token to track: ${token.token_symbol} (${token.token_address})`)
      } else {
        // Validate prices
        if (token.current_price <= 0) {
          console.warn(`Invalid current price for ${token.token_symbol}:`, token.current_price)
          continue
        }

        // Calculate current gain
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
    const failedUpdates = results.filter(result => result.status === 'rejected')
    
    if (failedUpdates.length > 0) {
      console.error(`⚠️ ${failedUpdates.length} updates failed:`, failedUpdates)
    }

    // Get updated statistics
    const { data: currentStats, error: statsError } = await supabase
      .from(TRACKER_TABLE)
      .select('status')
    
    if (statsError) {
      console.error('Failed to fetch current stats:', statsError)
    }

    const stats = {
      tracking: currentStats?.filter(t => t.status === 'tracking').length || 0,
      won: currentStats?.filter(t => t.status === 'won').length || 0,
      lost: currentStats?.filter(t => t.status === 'lost').length || 0
    }

    const summary = {
      success: true,
      timestamp: new Date().toISOString(),
      processed: filteredTokens.length,
      new_tokens_added: newTokensAdded,
      tokens_updated: tokensUpdated,
      tokens_lost: tokensLost,
      failed_updates: failedUpdates.length,
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

// GET method to retrieve trade comparison data for a specific token
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
    
    // If no trade comparison data exists, perform it now
    if (!token.trade_comparison_data) {
      console.log(`🔄 No trade comparison data found for ${token.token_symbol}, performing now...`)
      
      const tradeComparisonData = await performTradeComparison({
        token_address: token.token_address,
        token_symbol: token.token_symbol,
        token_name: token.token_name
      })
      
      if (tradeComparisonData) {
        // Update the token with trade comparison data
        const { error: updateError } = await supabase
          .from(TRACKER_TABLE)
          .update({
            trade_comparison_data: tradeComparisonData
          })
          .eq('id', token.id)
        
        if (updateError) {
          console.error('❌ Failed to update token with trade comparison data:', updateError)
        } else {
          token.trade_comparison_data = tradeComparisonData
        }
      }
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

// Track active trades to prevent duplicates
const activeTrades = new Set<string>()

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

async function canExecuteRealTrade(buyAmountSOL: number, tokenAddress?: string): Promise<{ canTrade: boolean, reason?: string }> {
  // Check if we can execute a real trade
  const { balance, canTrade: hasBalance } = await checkTradingBalance()
  
  if (!hasBalance) {
    return { canTrade: false, reason: `Insufficient balance: ${balance.toFixed(4)} SOL < ${MIN_SOL_BALANCE} SOL minimum` }
  }

  // Check for duplicate trade attempts
  if (tokenAddress && activeTrades.has(tokenAddress)) {
    return { canTrade: false, reason: `Trade already in progress for token ${tokenAddress}` }
  }

  const totalAtRisk = await getTotalSOLAtRisk()
  const newTotalAtRisk = totalAtRisk + buyAmountSOL

  if (newTotalAtRisk > MAX_SOL_AT_RISK) {
    return { canTrade: false, reason: `Risk limit exceeded: ${newTotalAtRisk.toFixed(4)} SOL > ${MAX_SOL_AT_RISK} SOL maximum` }
  }

  if (balance < buyAmountSOL + MIN_SOL_BALANCE) {
    return { canTrade: false, reason: `Insufficient balance for trade: need ${(buyAmountSOL + MIN_SOL_BALANCE).toFixed(4)} SOL, have ${balance.toFixed(4)} SOL` }
  }

  return { canTrade: true }
} 