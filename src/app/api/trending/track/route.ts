import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'
import { supabase } from '@/utils/supabase'
import { Connection, VersionedTransaction, Keypair, PublicKey } from '@solana/web3.js'
import { getSwapQuote, getSwapTransaction } from '@/utils/jupiter'
import { compareTradeQuotes, performEnhancedTradeComparison } from '@/utils/trade-comparison'
import { JupiterBaseAsset, JupiterPool, JupiterResponse } from '@/types'
import { withUnifiedLogging, log } from '@/utils/unified-logger'
import { notifyTradingUpdate } from '@/utils/trading-notifications'
import { addSLTPPosition } from '@/utils/sl-tp-tracker'
import { fetchTokenPricesForTracking } from '@/utils/trading-tracker'
import { assessTokenRisk, formatDetailedRiskForDiscord } from '@/utils/risk-assessment'
import { fetchTokenMetadataFromJupiter } from '@/utils/jupiter-metadata'
import { calculateGainPercentage } from '@/utils/trading-math'
import { createRpcConnection } from '@/utils/rpc-urls'

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

// Unified buy operation (supports both simulation and real trading)
// async function performBuyOperation(token: any, simulation: TradingSimulation): Promise<BuyOperation | null> {
//   // Get the strategy for this token
//   const strategyId = (simulation.buy_operation as any)?.bot_strategy || getCurrentBotStrategy()
//   const operationType = simulation.is_simulated ? 'simulation' : 'real'

//   return await executeBuyOperationWithStrategy(token, strategyId, operationType as 'simulation' | 'real', simulation)
// }

const DISCORD_MAX_LENGTH = 2000
const DISCORD_SAFE_LENGTH = 1900 // Leave some buffer

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

interface TokenFilterConfig {
  enabled: boolean
  mcap?: {
    min?: number
    max?: number
  }
  priceChange5m?: {
    min?: number
    max?: number
  }
  priceChange1h?: {
    min?: number
    max?: number
  }
  priceChange6h?: {
    min?: number
    max?: number
  }
  organicScore?: {
    min?: number
  }
  topHoldersPercentage?: {
    max?: number
  }
  requireCompleteData?: boolean
  checkManualTradingHistory?: boolean
}

// Default filter configuration
const DEFAULT_FILTER_CONFIG: TokenFilterConfig = {
  enabled: true,
  mcap: {
    min: 350_000,
    max: 3_000_000
  },
  priceChange5m: {
    max: -40.00
  },
  priceChange1h: {
    max: 100.00
  },
  priceChange6h: {
    max: 60.00
  },
  organicScore: {
    min: 70
  },
  topHoldersPercentage: {
    max: 25
  },
  requireCompleteData: true,
  checkManualTradingHistory: true
}

// Add trading strategy configuration interfaces
interface TradingStrategyConfig {
  id: string
  name: string
  description: string
  is_active: boolean
  take_profit_levels: {
    tp1_percentage: number
    tp1_sell_percentage: number
    tp2_percentage: number
    tp3_percentage: number
    tp3_enabled: boolean
  }
  buy_amount_sol: number
  priority_fee_lamports: number
  stop_loss_percentage: number
  max_hold_hours: number
  conditions?: {
    min_market_cap?: number
    max_market_cap?: number
    min_organic_score?: number
    max_risk_level?: 'low' | 'medium' | 'high'
  }
  filtering?: TokenFilterConfig
}

// Define available trading strategies
const TRADING_STRATEGIES: Record<string, TradingStrategyConfig> = {
  att: {
    id: 'att',
    name: 'Attention Strategy',
    description: 'Original aggressive trading strategy',
    is_active: true,
    take_profit_levels: {
      tp1_percentage: 45,
      tp1_sell_percentage: 90,
      tp2_percentage: 100,
      tp3_percentage: 30,
      tp3_enabled: false
    },
    buy_amount_sol: 0.035,
    priority_fee_lamports: 1000000,
    stop_loss_percentage: -35,
    max_hold_hours: 24,
    conditions: {
      max_risk_level: 'high'
    },
    // Aggressive filtering - allows more volatile tokens
    filtering: {
      enabled: true,
      mcap: {
        min: 200_000,
        max: 5_000_000
      },
      priceChange5m: {
        max: -50.00 // Allow deeper drops
      },
      priceChange1h: {
        max: 150.00 // Allow higher pumps
      },
      priceChange6h: {
        max: 80.00
      },
      organicScore: {
        min: 60 // Lower organic score requirement
      },
      topHoldersPercentage: {
        max: 30
      },
      requireCompleteData: true,
      checkManualTradingHistory: true
    }
  },
  lowcap_moonbag: {
    id: 'lowcap_moonbag',
    name: 'low cap potentail moonback',
    description: 'Lower risk, steady gains approach',
    is_active: true,
    take_profit_levels: {
      tp1_percentage: 200,
      tp1_sell_percentage: 90,
      tp2_percentage: 400,
      tp3_percentage: 600,
      tp3_enabled: true
    },
    buy_amount_sol: 0.008,
    priority_fee_lamports: 1000000,
    stop_loss_percentage: -30,
    max_hold_hours: 12,
    conditions: {
      min_market_cap: 35000,
      max_market_cap: 90000,
      min_organic_score: 0,
      max_risk_level: 'low'
    },
    // Conservative filtering - stricter requirements
    filtering: {
      enabled: true,
      mcap: {
        min: 35_000,
        max: 90_000
      },
      priceChange5m: {
        max: -25.00 // Less tolerance for drops
      },
      priceChange1h: {
        max: 600.00 // Lower pump tolerance
      },
      priceChange6h: {
        max: 600.00
      },
      organicScore: {
        min: 0 // Higher organic score requirement
      },
      topHoldersPercentage: {
        max: 25
      },
      requireCompleteData: true,
      checkManualTradingHistory: true
    }
  },
  scalper: {
    id: 'scalper',
    name: 'Scalping Strategy',
    description: 'Quick profits, fast exits',
    is_active: false,
    take_profit_levels: {
      tp1_percentage: 15,
      tp1_sell_percentage: 90,
      tp2_percentage: 25,
      tp3_percentage: 40,
      tp3_enabled: true
    },
    buy_amount_sol: 0.008,
    priority_fee_lamports: 1000000,
    stop_loss_percentage: -15,
    max_hold_hours: 6,
    conditions: {
      max_risk_level: 'medium'
    },
    // Scalper filtering - focus on momentum
    filtering: {
      enabled: true,
      mcap: {
        min: 300_000,
        max: 4_000_000
      },
      priceChange5m: {
        min: -30.00, // Allow some drops but not too severe
        max: -10.00
      },
      priceChange1h: {
        min: 20.00, // Require some upward momentum
        max: 80.00
      },
      priceChange6h: {
        max: 70.00
      },
      organicScore: {
        min: 65
      },
      topHoldersPercentage: {
        max: 25
      },
      requireCompleteData: true,
      checkManualTradingHistory: true
    }
  },
  hodl: {
    id: 'hodl',
    name: 'HODL Strategy',
    description: 'Long-term holding strategy',
    is_active: false,
    take_profit_levels: {
      tp1_percentage: 100,
      tp1_sell_percentage: 25,
      tp2_percentage: 200,
      tp3_percentage: 500,
      tp3_enabled: true
    },
    buy_amount_sol: 0.006,
    priority_fee_lamports: 1000000,
    stop_loss_percentage: -60,
    max_hold_hours: 168, // 7 days
    conditions: {
      min_market_cap: 500000,
      min_organic_score: 80,
      max_risk_level: 'low'
    },
    // HODL filtering - quality over quantity
    filtering: {
      enabled: true,
      mcap: {
        min: 1_000_000,
        max: 10_000_000 // Allow higher market cap
      },
      priceChange5m: {
        max: -20.00 // Very conservative on drops
      },
      priceChange1h: {
        max: 30.00 // Prefer steady growth
      },
      priceChange6h: {
        max: 50.00
      },
      organicScore: {
        min: 85 // Highest organic score requirement
      },
      topHoldersPercentage: {
        max: 15 // Strictest holder distribution
      },
      requireCompleteData: true,
      checkManualTradingHistory: true
    }
  }
}

function isStrategyActive(strategyId: string): boolean {
  const strategy = TRADING_STRATEGIES[strategyId]
  if (!strategy) {
    console.warn(`⚠️ Strategy '${strategyId}' not found`)
    return false
  }

  // Check for environment variable override first
  const envKey = `STRATEGY_ACTIVE_${strategyId.toUpperCase()}`
  const envValue = process.env[envKey]

  if (envValue !== undefined) {
    const isActive = envValue.toLowerCase() === 'true'
    console.log(`🔧 Strategy '${strategyId}' activation overridden by ${envKey}: ${isActive}`)
    return isActive
  }

  // Check global strategies enabled flag
  const globalEnabled = process.env.STRATEGIES_ENABLED
  if (globalEnabled !== undefined) {
    const isGlobalEnabled = globalEnabled.toLowerCase() === 'true'
    if (!isGlobalEnabled) {
      console.log(`🚫 All strategies disabled by STRATEGIES_ENABLED: false`)
      return false
    }
  }

  // Check day type (weekend/weekday) specific overrides
  const dayTypeInfo = isDayTypeWeekend()
  console.log(`🗓️ Current day: ${dayTypeInfo.dayName} (${dayTypeInfo.dayType})`)
  const dayTypeEnvKey = `STRATEGY_ACTIVE_${dayTypeInfo.dayType.toUpperCase()}_${strategyId.toUpperCase()}`
  const dayTypeEnvValue = process.env[dayTypeEnvKey]

  if (dayTypeEnvValue !== undefined) {
    const isDayTypeActive = dayTypeEnvValue.toLowerCase() === 'true'
    console.log(`🔧 Strategy '${strategyId}' ${dayTypeInfo.dayType} activation overridden by ${dayTypeEnvKey}: ${isDayTypeActive}`)
    return isDayTypeActive
  }

  // Check global weekend/weekday override
  const globalDayTypeEnvKey = `STRATEGIES_${dayTypeInfo.dayType.toUpperCase()}_ENABLED`
  const globalDayTypeEnvValue = process.env[globalDayTypeEnvKey]

  if (globalDayTypeEnvValue !== undefined) {
    const isGlobalDayTypeEnabled = globalDayTypeEnvValue.toLowerCase() === 'true'
    if (!isGlobalDayTypeEnabled) {
      console.log(`🚫 All strategies disabled for ${dayTypeInfo.dayType} (${dayTypeInfo.dayName}) by ${globalDayTypeEnvKey}: false`)
      return false
    }
  }

  console.log(`🔄 Strategy '${strategyId}' final activation state: ${strategy.is_active ? '✅ ACTIVE' : '❌ INACTIVE'}`)

  // Use default active state from strategy configuration
  return strategy.is_active
}

// Helper function to get all active strategies with their configurations
function getActiveStrategiesWithState(): { strategies: string[], configs: Record<string, TradingStrategyConfig>, allocation: Record<string, number> } {
  // First, get strategies that are marked as active
  const activeStrategyIds = Object.keys(TRADING_STRATEGIES).filter(strategyId => {
    const isActive = isStrategyActive(strategyId)
    console.log(`📊 Strategy '${strategyId}' (${TRADING_STRATEGIES[strategyId].name}): ${isActive ? '✅ ACTIVE' : '❌ INACTIVE'}`)
    return isActive
  })

  // If environment variables specify active strategies, intersect with active state
  const envStrategies = process.env.ACTIVE_STRATEGIES || process.env.BOT_STRATEGY || process.env.TRADING_STRATEGY
  let finalActiveStrategies = activeStrategyIds

  if (envStrategies) {
    const envStrategyList = envStrategies.split(',').map(s => s.trim()).filter(s => s)
    // Only include strategies that are both in environment AND marked as active
    finalActiveStrategies = activeStrategyIds.filter(strategyId =>
      envStrategyList.includes(strategyId)
    )

    console.log(`🔄 Environment strategies: [${envStrategyList.join(', ')}]`)
    console.log(`🔄 Active strategies: [${activeStrategyIds.join(', ')}]`)
    console.log(`🎯 Final active strategies: [${finalActiveStrategies.join(', ')}]`)
  }

  // Validate that we have at least one active strategy
  if (finalActiveStrategies.length === 0) {
    console.warn(`⚠️ No active strategies found! Falling back to 'att' strategy`)
    // Force activate ATT as fallback
    finalActiveStrategies = ['att']
  }

  // Get strategy configurations
  const activeConfigs: Record<string, TradingStrategyConfig> = {}
  finalActiveStrategies.forEach(strategyId => {
    if (TRADING_STRATEGIES[strategyId]) {
      activeConfigs[strategyId] = TRADING_STRATEGIES[strategyId]
    }
  })

  // Calculate allocation
  const allocationEnv = process.env.STRATEGY_ALLOCATION || ''
  const allocation: Record<string, number> = {}

  if (allocationEnv) {
    // Parse allocation like "att:0.4,conservative:0.3,scalper:0.3"
    const allocPairs = allocationEnv.split(',').map(s => s.trim())
    let totalAllocation = 0

    for (const pair of allocPairs) {
      const [strategyId, percentStr] = pair.split(':')
      const percent = parseFloat(percentStr)

      if (finalActiveStrategies.includes(strategyId) && !isNaN(percent) && percent > 0) {
        allocation[strategyId] = percent
        totalAllocation += percent
      }
    }

    // Normalize allocations to sum to 1.0
    if (totalAllocation > 0) {
      for (const strategyId of finalActiveStrategies) {
        if (allocation[strategyId]) {
          allocation[strategyId] = allocation[strategyId] / totalAllocation
        }
      }
    }
  }

  // If no valid allocation provided, use equal distribution
  if (Object.keys(allocation).length === 0) {
    const equalShare = 1.0 / finalActiveStrategies.length
    finalActiveStrategies.forEach(strategyId => {
      allocation[strategyId] = equalShare
    })
  }

  console.log(`🎯 Final active strategies with allocation:`, allocation)
  return {
    strategies: finalActiveStrategies,
    configs: activeConfigs,
    allocation
  }
}

// Helper function to get strategy status summary
function getStrategyStatusSummary(): { is_active: string[], is_inactive: string[], total: number } {
  const allStrategies = Object.keys(TRADING_STRATEGIES)
  const activeStrategies: string[] = []
  const inactiveStrategies: string[] = []

  allStrategies.forEach(strategyId => {
    if (isStrategyActive(strategyId)) {
      activeStrategies.push(strategyId)
    } else {
      inactiveStrategies.push(strategyId)
    }
  })

  return {
    is_active: activeStrategies,
    is_inactive: inactiveStrategies,
    total: allStrategies.length
  }
}

function setStrategyActiveState(strategyId: string, is_active: boolean): boolean {
  if (!TRADING_STRATEGIES[strategyId]) {
    console.error(`❌ Strategy '${strategyId}' not found`)
    return false
  }

  // Note: This modifies the in-memory configuration
  // For persistent changes, environment variables should be used
  TRADING_STRATEGIES[strategyId].is_active = is_active

  console.log(`🔄 Strategy '${strategyId}' (${TRADING_STRATEGIES[strategyId].name}) set to: ${is_active ? '✅ ACTIVE' : '❌ INACTIVE'}`)

  // Validate that at least one strategy remains is_active
  const statusSummary = getStrategyStatusSummary()
  if (statusSummary.is_active.length === 0) {
    console.warn(`⚠️ No strategies would be is_active! Reverting change for '${strategyId}'`)
    TRADING_STRATEGIES[strategyId].is_active = !is_active
    return false
  }

  return true
}

// Strategy validation and selection functions
function validateStrategyConfig(config: TradingStrategyConfig): boolean {
  // Validate percentage ranges
  if (config.take_profit_levels.tp1_percentage < 5 || config.take_profit_levels.tp1_percentage > 1000) return false
  if (config.take_profit_levels.tp1_sell_percentage < 10 || config.take_profit_levels.tp1_sell_percentage > 100) return false
  if (config.stop_loss_percentage > -5 || config.stop_loss_percentage < -90) return false
  if (config.max_hold_hours < 1 || config.max_hold_hours > 720) return false // Max 30 days

  return true
}

function getTradingStrategy(strategyId?: string): TradingStrategyConfig {
  // Default to 'att' if no strategy specified
  const selectedId = strategyId || process.env.DEFAULT_TRADING_STRATEGY || 'att'

  // Get strategy from registry
  const strategy = TRADING_STRATEGIES[selectedId]

  if (!strategy) {
    console.warn(`⚠️ Unknown trading strategy '${selectedId}', falling back to 'att'`)
    return TRADING_STRATEGIES.att
  }

  // Validate strategy configuration
  if (!validateStrategyConfig(strategy)) {
    console.error(`❌ Invalid strategy configuration for '${selectedId}', falling back to 'att'`)
    return TRADING_STRATEGIES.att
  }

  return strategy
}

// Helper function to create TradingSimulation with strategy configuration
function createTradingSimulation(
  token: any,
  strategyId?: string,
  isRealTradingActive: boolean = false,
  keypairPath?: string,
  startTime?: string
): TradingSimulation {
  const strategy = getTradingStrategy(strategyId)

  console.log(`🎯 Creating trading simulation for ${token.token_symbol} using '${strategy.name}' strategy`)

  return {
    token_address: token.token_address,
    token_symbol: token.token_symbol,
    simulation_started_at: startTime || new Date().toISOString(),
    buy_operation: null,
    sell_operations: [],
    current_status: 'buying',
    remaining_token_amount: '0',
    initial_token_amount: '0',
    is_simulated: !isRealTradingActive,
    keypair_path: keypairPath,
    take_profit_levels: { ...strategy.take_profit_levels },
    stop_loss_percentage: strategy.stop_loss_percentage,
    max_hold_hours: strategy.max_hold_hours,
    final_result: null
  }
}

function getActiveStrategies(): { strategies: string[], allocation: Record<string, number> } {
  const { strategies, allocation } = getActiveStrategiesWithState()
  return { strategies, allocation }
}

function getCurrentBotStrategy(): string {
  // Maintain backward compatibility - return first active strategy
  const { strategies } = getActiveStrategies()
  return strategies[0]
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
  strategy?: string
  tokenData?: any // Add this field
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

// Add synchronized trade execution interfaces
interface SyncedTradeResult {
  simulation: TradeExecutionResult
  real?: TradeExecutionResult
  quote: any // The shared Jupiter quote
  deviation?: {
    outputAmountDiff: number
    outputAmountDiffPercent: number
    feesDiff: number
    responseTimeDiff: number
  }
}

// Add new interfaces for filtering tracking
interface TokenFilterResult {
  token: any // Original pool data from Jupiter
  passed: boolean
  rejectionReasons: string[]
  mappedToken?: any // Mapped token data if passed
}

interface RejectionDetail {
  reason: string
  count: number
  tokens: Array<{
    name: string
    symbol: string
    address: string
    price: number
    mcap?: number
    organicScore?: number
  }>
}

interface FilteringSummary {
  totalTokens: number
  acceptedTokens: number
  rejectedTokens: number
  rejectionBreakdown: { [reason: string]: number }
  rejectionDetails: RejectionDetail[] // New field for detailed token info
  processingTime: number
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

// Modified SimulationExecutor to use Jupiter quotes for synchronization
class SyncedSimulationExecutor implements TradeExecutor {
  async executeBuy(params: TradeExecutionParams): Promise<TradeExecutionResult> {
    try {
      // Use Jupiter quote directly (same as real trading) instead of multi-provider comparison
      console.log(`🔄 Getting Jupiter quote for simulation ${params.tokenSymbol}...`)
      const quote = await getSwapQuote(
        params.inputMint,
        params.outputMint,
        params.amount,
        params.slippageBps
      )

      if (!quote) {
        return {
          success: false,
          inputAmount: params.amount.toString(),
          outputAmount: '0',
          fees: { totalFees: 0, feePercentage: 0 },
          provider: 'jupiter',
          rpcUsed: 'simulation',
          responseTime: 0,
          error: 'No Jupiter quote available'
        }
      }

      return {
        success: true,
        inputAmount: quote.inAmount,
        outputAmount: quote.outAmount,
        fees: {
          totalFees: quote.platformFee ? parseInt(quote.platformFee.amount) / 1e9 : 0,
          feePercentage: quote.platformFee ? quote.platformFee.feeBps / 100 : 0
        },
        provider: 'jupiter',
        rpcUsed: 'simulation',
        responseTime: 100, // Simulated response time
      }
    } catch (error) {
      return {
        success: false,
        inputAmount: params.amount.toString(),
        outputAmount: '0',
        fees: { totalFees: 0, feePercentage: 0 },
        provider: 'jupiter',
        rpcUsed: 'simulation',
        responseTime: 0,
        error: error instanceof Error ? error.message : 'Simulation failed'
      }
    }
  }

  async executeSell(params: TradeExecutionParams): Promise<TradeExecutionResult> {
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
    const startTime = Date.now();

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

// Synchronized trade executor that runs both simulation and real trading with the same quote
class SynchronizedTradeExecutor {
  private realExecutor?: RealTradeExecutor
  private simExecutor: SyncedSimulationExecutor

  constructor(
    connection?: Connection,
    signer?: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>
  ) {
    this.simExecutor = new SyncedSimulationExecutor()
    if (connection && signer) {
      this.realExecutor = new RealTradeExecutor(connection, signer)
    }
  }

  async executeSyncedBuy(params: TradeExecutionParams, executeReal: boolean = false): Promise<SyncedTradeResult> {
    const startTime = Date.now()

    // Get shared Jupiter quote first
    console.warn(`🔄 Getting shared Jupiter quote for ${params.tokenSymbol}...`)
    const quote = await getSwapQuote(
      params.inputMint,
      params.outputMint,
      params.amount,
      params.slippageBps
    )

    if (!quote) {
      const failedResult = {
        success: false,
        inputAmount: params.amount.toString(),
        outputAmount: '0',
        fees: { totalFees: 0, feePercentage: 0 },
        provider: 'jupiter',
        rpcUsed: 'none',
        responseTime: Date.now() - startTime,
        error: 'No Jupiter quote available'
      }
      return {
        simulation: failedResult,
        quote: null
      }
    }

    console.log(`📊 Shared Jupiter quote: ${quote.inAmount} → ${quote.outAmount}`)

    // Execute simulation (always)
    const simulationResult = await this.simExecutor.executeBuy(params)

    // Execute real trade if requested and executor available
    let realResult: TradeExecutionResult | undefined
    if (executeReal && this.realExecutor) {
      console.warn(`🔥 Executing real trade with same quote...`)
      realResult = await this.realExecutor.executeBuy(params)
    }

    // Calculate deviation if both results exist
    let deviation: SyncedTradeResult['deviation']
    if (realResult && simulationResult.success && realResult.success) {
      const simOutput = parseFloat(simulationResult.outputAmount)
      const realOutput = parseFloat(realResult.outputAmount)
      const outputDiff = Math.abs(simOutput - realOutput)
      const outputDiffPercent = simOutput > 0 ? (outputDiff / simOutput) * 100 : 0

      deviation = {
        outputAmountDiff: outputDiff,
        outputAmountDiffPercent: outputDiffPercent,
        feesDiff: Math.abs(simulationResult.fees.totalFees - realResult.fees.totalFees),
        responseTimeDiff: Math.abs(simulationResult.responseTime - realResult.responseTime)
      }

      // Log significant deviations
      if (outputDiffPercent > 2) { // More than 2% difference
        logTradeOperation('Significant Trade Deviation Detected', {
          tokenSymbol: params.tokenSymbol,
          simulationOutput: simulationResult.outputAmount,
          realOutput: realResult.outputAmount,
          deviationPercent: outputDiffPercent.toFixed(2),
          simulationFees: simulationResult.fees.totalFees,
          realFees: realResult.fees.totalFees,
          quote: {
            inAmount: quote.inAmount,
            outAmount: quote.outAmount
          }
        })
      }
    }

    const syncResult = {
      simulation: simulationResult,
      real: realResult,
      quote,
      deviation
    }

    // Send Discord notification for sync results
    if (shouldEnableNotifications() && (simulationResult.success || (realResult && realResult.success))) {
      try {
        await sendSyncTradeNotificationDiscord({
          tokenSymbol: params.tokenSymbol,
          tokenAddress: params.tokenAddress,
          operationType: 'buy',
          syncResult,
          isRealTradeExecuted: executeReal && !!realResult,
          tokenData: params.tokenData
        })
      } catch (discordError) {
        console.error('❌ Failed to send sync Discord notification:', discordError)
        // Don't fail the trade if Discord notification fails
      }
    }

    return syncResult
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

// Update the factory function to support synchronized execution
function createSynchronizedTradeExecutor(
  connection?: Connection,
  signer?: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>
): SynchronizedTradeExecutor {
  return new SynchronizedTradeExecutor(connection, signer)
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

// Helper function to truncate message content to fit Discord limits
function truncateDiscordMessage(lines: string[], maxLength: number = DISCORD_SAFE_LENGTH): string {
  let content = lines.join('\n')

  if (content.length <= maxLength) {
    return content
  }

  // Progressive truncation strategy
  let truncatedLines = [...lines]

  // Strategy 1: Remove detailed token information progressively
  while (content.length > maxLength && truncatedLines.length > 10) {
    // Find and remove the longest lines (usually token details)
    const longestIndex = truncatedLines.reduce((maxIdx, line, idx, arr) =>
      line.length > arr[maxIdx].length ? idx : maxIdx, 0)

    if (truncatedLines[longestIndex].includes('💰 Price:') ||
      truncatedLines[longestIndex].includes('🏷️ Symbol:') ||
      truncatedLines[longestIndex].includes('📊 [View Chart]')) {
      truncatedLines.splice(longestIndex, 1)
      content = truncatedLines.join('\n')
    } else {
      break
    }
  }

  // Strategy 2: If still too long, keep only essential information
  if (content.length > maxLength) {
    const essentialLines = truncatedLines.filter(line =>
      line.includes('Token Filtering Summary') ||
      line.includes('Processing Results:') ||
      line.includes('Total Scanned:') ||
      line.includes('Accepted:') ||
      line.includes('Rejected:') ||
      line.includes('Processing Time:') ||
      line.includes('**') && line.includes(':') && !line.includes('💰') ||
      line === '' ||
      line.includes('⏰')
    )

    content = essentialLines.join('\n')
  }

  // Final fallback: Hard truncate with ellipsis
  if (content.length > maxLength) {
    content = content.substring(0, maxLength - 20) + '\n\n... (truncated)'
  }

  return content
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
    const reloadSolLink = `https://reloadsol.app/buy?sol=0.1&mints=${tokenAddress}`

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

// Enhanced Discord notification for successful buy operations
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
  marketCap?: number
  riskAssessment?: any
  graduatedAt?: string | null
  launchpad?: string | null
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
      totalFees,
      marketCap,
      riskAssessment,
      graduatedAt,
      launchpad
    } = params

    // Log notification attempt with new data
    logTradeOperation('Discord Buy Notification Attempt', {
      tokenSymbol,
      tokenAddress,
      isSimulated,
      amountSOL,
      provider,
      signature: signature ? `${signature.slice(0, 8)}...` : 'none',
      marketCap,
      riskLevel: riskAssessment?.riskLevel,
      graduatedAt,
      launchpad
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

    // Add market cap if available
    if (marketCap && marketCap > 0) {
      lines.push(`💎 Market Cap: $${marketCap.toLocaleString()}`)
    }

    // Add risk assessment if available
    if (riskAssessment) {
      const riskEmoji = riskAssessment.riskLevel === 'LOW' ? '🟢' :
        riskAssessment.riskLevel === 'MED' ? '🟡' : '🔴'
      lines.push(`${riskEmoji} Risk: ${riskAssessment.riskLevel}`)

      // Add detailed risk metrics if available
      if (riskAssessment.axiomData || riskAssessment.jupiterDetails) {
        const detailedRisk = formatDetailedRiskForDiscord(
          { token_address: tokenAddress, token_symbol: tokenSymbol || 'UNKNOWN', mcap: marketCap || 0, price: priceUSD },
          riskAssessment
        )
        lines.push(`📈 Metrics: ${detailedRisk}`)
      }
    }

    // Add graduatedAt if available
    if (graduatedAt) {
      lines.push(`🎓 Graduated: ${graduatedAt}`)
    }

    // Add launchpad if available
    if (launchpad) {
      lines.push(`From launchpad: ${launchpad}`)
    }

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

    // Log successful notification with enhanced data
    logTradeOperation('Discord Buy Notification Success', {
      tokenSymbol,
      isSimulated,
      signature: signature ? `${signature.slice(0, 8)}...` : 'none',
      responseTime: webhookResponseTime,
      httpStatus: response.status,
      marketCap,
      riskLevel: riskAssessment?.riskLevel,
      graduatedAt
    })
  } catch (err) {
    // Enhanced error logging
    logTradeOperation('Discord Buy Notification Error', {
      tokenSymbol: params.tokenSymbol,
      isSimulated: params.isSimulated,
      amountSOL: params.amountSOL,
      signature: params.signature ? `${params.signature.slice(0, 8)}...` : 'none',
      marketCap: params.marketCap,
      riskLevel: params.riskAssessment?.riskLevel
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

// Add new Discord notification functions
async function sendFilteringSummaryDiscord(summary: FilteringSummary, isRealTrading: boolean) {
  log.debug('discord_notification', 'sendFilteringSummaryDiscord called', {
    totalTokens: summary.totalTokens,
    acceptedTokens: summary.acceptedTokens,
    rejectedTokens: summary.rejectedTokens,
    isRealTrading,
    rejectionDetailsCount: summary.rejectionDetails.length
  })

  try {
    const notificationsEnabled = shouldEnableNotifications()
    log.info('discord_notification', 'Discord notifications status check', {
      enabled: notificationsEnabled
    })

    if (!notificationsEnabled) {
      log.warn('discord_notification', 'Discord notifications disabled - skipping filtering summary', {
        webhookUrl: !!DISCORD_WEBHOOK_URL ? 'configured' : 'missing'
      })
      logTradeOperation('Discord Filtering Summary Skipped', {
        reason: 'Notifications disabled',
        webhookUrl: !!DISCORD_WEBHOOK_URL ? 'configured' : 'missing'
      })
      return
    }

    log.info('discord_notification', 'Proceeding with Discord filtering summary notification')

    const emoji = isRealTrading ? '🔥' : '💻'
    const mode = isRealTrading ? 'LIVE TRADING' : 'SIMULATION'

    const lines = [
      `${emoji} Token Filtering Summary (${mode})`,
      ``,
      `📊 **Processing Results:**`,
      `🔍 Total Scanned: ${summary.totalTokens}`,
      `✅ Accepted: ${summary.acceptedTokens}`,
      `❌ Rejected: ${summary.rejectedTokens}`,
      `⚡ Processing Time: ${summary.processingTime}ms`,
      ``,
      `📋 **Rejection Breakdown:**`
    ]

    // Add rejection reasons breakdown with adaptive detail level
    const sortedDetails = summary.rejectionDetails.sort((a, b) => b.count - a.count)

    // Estimate space available for rejection details
    const baseMessageLength = lines.join('\n').length + 50 // +50 for timestamp
    const availableSpace = DISCORD_SAFE_LENGTH - baseMessageLength

    let tokensPerReason = 2 // Start with 2 tokens per reason
    let maxReasons = Math.min(sortedDetails.length, 8) // Limit reasons shown

    // Adjust detail level based on available space
    if (availableSpace < 800) {
      tokensPerReason = 1
      maxReasons = Math.min(sortedDetails.length, 5)
    } else if (availableSpace < 1200) {
      tokensPerReason = 2
      maxReasons = Math.min(sortedDetails.length, 6)
    }

    sortedDetails.slice(0, maxReasons).forEach(detail => {
      lines.push(``)
      lines.push(`${getRejectionEmoji(detail.reason)} **${detail.reason}: ${detail.count}**`)

      // Show limited tokens for each rejection reason
      const topTokens = detail.tokens.slice(0, tokensPerReason)
      topTokens.forEach((token, index) => {
        const tokenName = token.name || token.symbol || 'UNKNOWN'
        const price = token.price ? `$${token.price.toFixed(6)}` : 'N/A' // Reduced precision
        const mcap = token.mcap ? `$${(token.mcap / 1000000).toFixed(1)}M` : 'N/A'
        const score = token.organicScore ? token.organicScore.toFixed(0) : 'N/A' // Reduced precision

        lines.push(`   ${index + 1}. **${tokenName}** (${token.symbol})`)
        lines.push(`      💰 ${price} | 🏦 ${mcap} | 🎯 ${score}`)
      })

      if (detail.tokens.length > tokensPerReason) {
        lines.push(`      ... +${detail.tokens.length - tokensPerReason} more`)
      }
    })

    if (sortedDetails.length > maxReasons) {
      lines.push(``)
      lines.push(`... and ${sortedDetails.length - maxReasons} more rejection reasons`)
    }

    lines.push(``)
    lines.push(`⏰ ${new Date().toLocaleString()}`)

    // Apply length management
    const content = truncateDiscordMessage(lines)

    log.debug('discord_notification', 'Discord message prepared with length management', {
      originalLength: lines.join('\n').length,
      finalLength: content.length,
      withinLimit: content.length <= DISCORD_MAX_LENGTH
    })

    log.info('discord_notification', 'Sending Discord webhook request', {
      webhookConfigured: !!DISCORD_WEBHOOK_URL,
      messageLength: content.length
    })

    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    })

    log.info('discord_notification', 'Discord webhook response received', {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok
    })

    if (!response.ok) {
      const errorText = await response.text()
      log.error('discord_notification', 'Discord webhook failed', new Error(`${response.status} - ${errorText}`), {
        status: response.status,
        errorText,
        messageLength: content.length
      })
      throw new Error(`Discord webhook failed: ${response.status} - ${errorText}`)
    }

    log.info('discord_notification', 'Discord filtering summary sent successfully', {
      totalTokens: summary.totalTokens,
      acceptedTokens: summary.acceptedTokens,
      rejectedTokens: summary.rejectedTokens,
      messageLength: content.length
    })

    logTradeOperation('Discord Filtering Summary Success', {
      totalTokens: summary.totalTokens,
      acceptedTokens: summary.acceptedTokens,
      rejectedTokens: summary.rejectedTokens,
      messageLength: content.length
    })
  } catch (err) {
    log.error('discord_notification', 'Error in sendFilteringSummaryDiscord', err as Error, {
      totalTokens: summary.totalTokens
    })
    logTradeOperation('Discord Filtering Summary Error', {
      totalTokens: summary.totalTokens,
      error: err instanceof Error ? err.message : String(err)
    }, err as Error)
  }
}

async function sendRejectedTokensDiscord(rejectedTokens: TokenFilterResult[], isRealTrading: boolean) {
  log.debug('discord_notification', 'sendRejectedTokensDiscord called', {
    rejectedTokensCount: rejectedTokens.length,
    isRealTrading
  })

  try {
    const notificationsEnabled = shouldEnableNotifications()
    log.info('discord_notification', 'Discord notifications status for rejected tokens', {
      enabled: notificationsEnabled
    })

    if (!notificationsEnabled || rejectedTokens.length === 0) {
      log.warn('discord_notification', 'Skipping rejected tokens Discord notification', {
        notificationsEnabled,
        hasRejectedTokens: rejectedTokens.length > 0
      })
      return
    }

    log.info('discord_notification', 'Proceeding with Discord rejected tokens notification')

    const emoji = isRealTrading ? '🔥' : '💻'
    const mode = isRealTrading ? 'LIVE TRADING' : 'SIMULATION'

    // Filter tokens with market cap <= 3M and get only symbols
    const filteredTokens = rejectedTokens.filter(result => {
      const mcap = result.token.baseAsset.mcap
      return mcap && mcap <= 3_000_000
    })

    // Dynamic limit based on total count
    let maxTokensToShow = Math.min(10, filteredTokens.length)
    if (filteredTokens.length > 50) {
      maxTokensToShow = 5
    } else if (filteredTokens.length > 20) {
      maxTokensToShow = 8
    }

    const topRejected = filteredTokens.slice(0, maxTokensToShow)

    const lines = [
      `${emoji} Rejected Tokens (${mode}) - Max 3M Market Cap`,
      ``,
      `❌ **Top ${topRejected.length} of ${filteredTokens.length} Rejected Tokens:**`,
      ``
    ]

    // Simple format - only show symbols
    const symbols = topRejected.map(result => result.token.baseAsset.symbol || 'UNKNOWN')
    lines.push(symbols.join(', '))
    lines.push(``)

    if (filteredTokens.length > maxTokensToShow) {
      lines.push(`... and ${filteredTokens.length - maxTokensToShow} more rejected tokens`)
      lines.push(``)
    }

    lines.push(`⏰ ${new Date().toLocaleString()}`)

    // Apply length management
    const content = truncateDiscordMessage(lines)

    log.debug('discord_notification', 'Discord rejected tokens message prepared with simplified format', {
      originalLength: lines.join('\n').length,
      finalLength: content.length,
      withinLimit: content.length <= DISCORD_MAX_LENGTH,
      tokensShown: topRejected.length,
      filteredCount: filteredTokens.length,
      totalRejected: rejectedTokens.length
    })

    log.info('discord_notification', 'Sending Discord rejected tokens webhook request', {
      messageLength: content.length
    })

    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    })

    log.info('discord_notification', 'Discord rejected tokens webhook response received', {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok
    })

    if (!response.ok) {
      const errorText = await response.text()
      log.error('discord_notification', 'Discord rejected tokens webhook failed', new Error(`${response.status} - ${errorText}`), {
        status: response.status,
        errorText,
        messageLength: content.length
      })
      throw new Error(`Discord webhook failed: ${response.status} - ${errorText}`)
    }

    log.info('discord_notification', 'Discord rejected tokens notification sent successfully', {
      rejectedCount: rejectedTokens.length,
      filteredCount: filteredTokens.length,
      tokensShown: topRejected.length,
      messageLength: content.length
    })

    logTradeOperation('Discord Rejected Tokens Success', {
      rejectedCount: rejectedTokens.length,
      filteredCount: filteredTokens.length,
      tokensShown: topRejected.length,
      messageLength: content.length
    })
  } catch (err) {
    log.error('discord_notification', 'Error in sendRejectedTokensDiscord', err as Error, {
      rejectedCount: rejectedTokens.length
    })
    logTradeOperation('Discord Rejected Tokens Error', {
      rejectedCount: rejectedTokens.length,
      error: err instanceof Error ? err.message : String(err)
    }, err as Error)
  }
}

// Helper function to get appropriate emoji for rejection reasons
function getRejectionEmoji(reason: string): string {
  const emojiMap: { [key: string]: string } = {
    'Price drop too severe': '📉',
    'Price rise too high (1h)': '🚀',
    'Price rise too high (6h)': '📈',
    'Organic score too low': '🎯',
    'Market cap too low': '💸',
    'Market cap too high': '💰',
    'Top holders percentage too high': '👥',
    'Missing required data': '❓'
  }
  return emojiMap[reason] || '❌'
}

// Helper function to check if tokens have been manually traded (batch check)
async function checkManualTradingHistoryBatch(tokenAddresses: string[]): Promise<Set<string>> {
  try {
    const manuallyTradedTokens = new Set<string>()

    // Query trading_records table for any manual trades (is_bot_operation = false or null)
    const { data, error } = await supabase
      .from('trading_records')
      .select('data')
      .or('data->>is_bot_operation.is.null,data->>is_bot_operation.eq.false')

    if (error) {
      console.error('Error checking manual trading history:', error)
      return manuallyTradedTokens // Return empty set if we can't check
    }

    if (!data || data.length === 0) {
      return manuallyTradedTokens // No manual trades found
    }

    // Check each record for tokens that match our list
    for (const record of data) {
      const recordData = record.data
      if (recordData && recordData.tokens && Array.isArray(recordData.tokens)) {
        recordData.tokens.forEach((token: any) => {
          if (token.mintAddress && tokenAddresses.includes(token.mintAddress)) {
            manuallyTradedTokens.add(token.mintAddress)
          }
        })
      }
    }

    return manuallyTradedTokens
  } catch (error) {
    console.error('Error in checkManualTradingHistoryBatch:', error)
    return new Set<string>() // Return empty set if error occurs
  }
}

// Enhanced filtering function with detailed tracking and token collection
async function performEnhancedFiltering(
  pools: any[],
  strategyId?: string,
  customConfig?: Partial<TokenFilterConfig>
): Promise<{ results: TokenFilterResult[], summary: FilteringSummary }> {
  const startTime = Date.now()
  const results: TokenFilterResult[] = []
  const rejectionBreakdown: { [reason: string]: number } = {}
  const rejectionTokens: {
    [reason: string]: Array<{
      name: string
      symbol: string
      address: string
      price: number
      mcap?: number
      organicScore?: number
    }>
  } = {}

  // Get filtering configuration based on strategy
  let filterConfig: TokenFilterConfig

  if (customConfig && Object.keys(customConfig).length > 0) {
    // Use custom configuration if provided
    filterConfig = { ...DEFAULT_FILTER_CONFIG, ...customConfig }
  } else if (strategyId) {
    // Use strategy-specific configuration
    const strategy = getTradingStrategy(strategyId)
    filterConfig = strategy.filtering || DEFAULT_FILTER_CONFIG
  } else {
    // Use default configuration
    filterConfig = DEFAULT_FILTER_CONFIG
  }

  console.log(`🔍 Using filtering configuration for strategy '${strategyId || 'default'}':`, filterConfig)

  // Skip filtering if disabled
  if (!filterConfig.enabled) {
    console.log('🚫 Filtering disabled, accepting all tokens')
    const mappedResults = pools.map(pool => ({
      token: pool,
      passed: true,
      rejectionReasons: [],
      mappedToken: {
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
      }
    }))

    return {
      results: mappedResults,
      summary: {
        totalTokens: pools.length,
        acceptedTokens: pools.length,
        rejectedTokens: 0,
        rejectionBreakdown: {},
        rejectionDetails: [],
        processingTime: Date.now() - startTime
      }
    }
  }

  // Extract all token addresses for batch checking
  const tokenAddresses = pools
    .map(pool => pool.baseAsset.id)
    .filter(id => id) // Remove null/undefined values

  // Batch check for manually traded tokens (if enabled)
  let manuallyTradedTokens = new Set<string>()
  if (filterConfig.checkManualTradingHistory) {
    manuallyTradedTokens = await checkManualTradingHistoryBatch(tokenAddresses)
    console.log(`🔍 Found ${manuallyTradedTokens.size} manually traded tokens out of ${tokenAddresses.length} tokens`)
  }

  pools.forEach(pool => {
    const rejectionReasons: string[] = []

    // Extract token data
    const priceChange5m = pool.baseAsset.stats5m?.priceChange ?? 0
    const priceChange1h = pool.baseAsset.stats1h?.priceChange ?? 0
    const priceChange6h = pool.baseAsset.stats6h?.priceChange ?? 0
    const organicScore = pool.baseAsset.organicScore
    const mcap = pool.baseAsset.mcap
    const topHoldersPercentage = pool.baseAsset.audit?.topHoldersPercentage

    // Apply dynamic filters based on configuration

    // Market cap filtering
    if (filterConfig.mcap) {
      if (filterConfig.mcap.min && (!mcap || mcap <= filterConfig.mcap.min)) {
        console.log(`🔍 Token ${pool.baseAsset.symbol} rejected: Market cap ${mcap} below minimum ${filterConfig.mcap.min}`);
        rejectionReasons.push(`Market cap too low (${mcap ? `$${(mcap / 1000).toFixed(0)}k` : 'N/A'} <= $${(filterConfig.mcap.min / 1000).toFixed(0)}k)`)
      }
      if (filterConfig.mcap.max && (!mcap || mcap >= filterConfig.mcap.max)) {
        console.log(`🔍 Token ${pool.baseAsset.symbol} (${pool.baseAsset.id}) rejected: Market cap $${(mcap / 1000000).toFixed(2)}M above maximum $${(filterConfig.mcap.max / 1000).toFixed(0)}k`);
        rejectionReasons.push(`Market cap too high (${mcap ? `$${(mcap / 1000000).toFixed(1)}M` : 'N/A'} >= $${(filterConfig.mcap.max / 1000000).toFixed(1)}M)`)
      }
    }

    // Price change 5m filtering
    if (filterConfig.priceChange5m) {
      if (filterConfig.priceChange5m.min && priceChange5m <= filterConfig.priceChange5m.min) {
        rejectionReasons.push(`5m price drop too severe (${priceChange5m.toFixed(2)}% <= ${filterConfig.priceChange5m.min}%)`)
      }
      if (filterConfig.priceChange5m.max && priceChange5m <= filterConfig.priceChange5m.max) {
        rejectionReasons.push(`5m price drop too severe (${priceChange5m.toFixed(2)}% <= ${filterConfig.priceChange5m.max}%)`)
      }
    }

    // Price change 1h filtering
    if (filterConfig.priceChange1h) {
      if (filterConfig.priceChange1h.min && priceChange1h <= filterConfig.priceChange1h.min) {
        rejectionReasons.push(`1h price rise insufficient (${priceChange1h.toFixed(2)}% <= ${filterConfig.priceChange1h.min}%)`)
      }
      if (filterConfig.priceChange1h.max && priceChange1h >= filterConfig.priceChange1h.max) {
        rejectionReasons.push(`1h price rise too high (${priceChange1h.toFixed(2)}% >= ${filterConfig.priceChange1h.max}%)`)
      }
    }

    // Price change 6h filtering
    if (filterConfig.priceChange6h) {
      if (filterConfig.priceChange6h.min && priceChange6h <= filterConfig.priceChange6h.min) {
        rejectionReasons.push(`6h price rise insufficient (${priceChange6h.toFixed(2)}% <= ${filterConfig.priceChange6h.min}%)`)
      }
      if (filterConfig.priceChange6h.max && priceChange6h >= filterConfig.priceChange6h.max) {
        rejectionReasons.push(`6h price rise too high (${priceChange6h.toFixed(2)}% >= ${filterConfig.priceChange6h.max}%)`)
      }
    }

    // Organic score filtering
    if (filterConfig.organicScore?.min && (!organicScore || organicScore < filterConfig.organicScore.min)) {
      rejectionReasons.push(`Organic score too low (${organicScore || 'N/A'} < ${filterConfig.organicScore.min})`)
    }

    // Top holders percentage filtering
    if (filterConfig.topHoldersPercentage?.max && (!topHoldersPercentage || topHoldersPercentage >= filterConfig.topHoldersPercentage.max)) {
      rejectionReasons.push(`Top holders percentage too high (${topHoldersPercentage || 'N/A'}% >= ${filterConfig.topHoldersPercentage.max}%)`)
    }

    // Data completeness check
    if (filterConfig.requireCompleteData && (!pool.baseAsset.id || !pool.baseAsset.symbol || !pool.baseAsset.usdPrice)) {
      rejectionReasons.push('Missing required data')
    }

    // Manual trading history check
    if (filterConfig.checkManualTradingHistory && pool.baseAsset.id && manuallyTradedTokens.has(pool.baseAsset.id)) {
      rejectionReasons.push('Token already traded manually')
    }

    const passed = rejectionReasons.length === 0

    if (passed) {
      console.log(`✅ Token ${pool.baseAsset.symbol} (${pool.baseAsset.id}) PASSED filters under strategy '${strategyId || 'default'}' with Market cap $${(mcap ? mcap / 1000000 : 0).toFixed(2)}M`)
    }

    // Track rejection reasons and collect token details
    rejectionReasons.forEach(reason => {
      rejectionBreakdown[reason] = (rejectionBreakdown[reason] || 0) + 1

      // Initialize array if it doesn't exist
      if (!rejectionTokens[reason]) {
        rejectionTokens[reason] = []
      }

      // Add token details to the rejection reason
      rejectionTokens[reason].push({
        name: pool.baseAsset.name || pool.baseAsset.symbol || 'UNKNOWN',
        symbol: pool.baseAsset.symbol || 'UNKNOWN',
        address: pool.baseAsset.id || 'UNKNOWN',
        price: pool.baseAsset.usdPrice || 0,
        mcap: pool.baseAsset.mcap,
        organicScore: pool.baseAsset.organicScore
      })
    })

    const result: TokenFilterResult = {
      token: pool,
      passed,
      rejectionReasons
    }

    // If passed, create mapped token data
    if (passed) {
      result.mappedToken = {
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
      }
    }

    results.push(result)
  })

  const processingTime = Date.now() - startTime
  const acceptedTokens = results.filter(r => r.passed).length
  const rejectedTokens = results.filter(r => !r.passed).length

  // Create rejection details array
  const rejectionDetails: RejectionDetail[] = Object.entries(rejectionBreakdown).map(([reason, count]) => ({
    reason,
    count,
    tokens: rejectionTokens[reason] || []
  }))

  const summary: FilteringSummary = {
    totalTokens: pools.length,
    acceptedTokens,
    rejectedTokens,
    rejectionBreakdown,
    rejectionDetails,
    processingTime
  }

  console.log(`🎯 Filtering completed for strategy '${strategyId || 'default'}': ${acceptedTokens}/${pools.length} tokens passed`)

  return { results, summary }
}

function parseCustomFilterConfig(): Partial<TokenFilterConfig> | null {
  try {
    // Check for environment variable with custom filter config
    const customConfigEnv = process.env.CUSTOM_FILTER_CONFIG
    if (customConfigEnv) {
      return JSON.parse(customConfigEnv)
    }

    // Check for individual environment variables
    const customConfig: Partial<TokenFilterConfig> = {}

    if (process.env.FILTER_ENABLED !== undefined) {
      customConfig.enabled = process.env.FILTER_ENABLED === 'true'
    }

    if (process.env.FILTER_MCAP_MIN) {
      customConfig.mcap = { ...customConfig.mcap, min: parseInt(process.env.FILTER_MCAP_MIN) }
    }

    if (process.env.FILTER_MCAP_MAX) {
      customConfig.mcap = { ...customConfig.mcap, max: parseInt(process.env.FILTER_MCAP_MAX) }
    }

    if (process.env.FILTER_PRICE_5M_MAX) {
      customConfig.priceChange5m = { max: parseFloat(process.env.FILTER_PRICE_5M_MAX) }
    }

    if (process.env.FILTER_PRICE_1H_MAX) {
      customConfig.priceChange1h = { max: parseFloat(process.env.FILTER_PRICE_1H_MAX) }
    }

    if (process.env.FILTER_PRICE_6H_MAX) {
      customConfig.priceChange6h = { max: parseFloat(process.env.FILTER_PRICE_6H_MAX) }
    }

    if (process.env.FILTER_ORGANIC_SCORE_MIN) {
      customConfig.organicScore = { min: parseInt(process.env.FILTER_ORGANIC_SCORE_MIN) }
    }

    // Return null if no custom config found
    return Object.keys(customConfig).length > 0 ? customConfig : null
  } catch (error) {
    console.error('Error parsing custom filter configuration:', error)
    return null
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

    // Get the PnL update token from environment variables
    const pnlToken = process.env.PNL_UPDATE_TOKEN || 'r3l0ads0l-pnl'

    // Call the PnL update API internally
    const pnlResponse = await fetch(`${process.env.VERCEL_URL || 'http://localhost:3000'}/api/pnl/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pnlToken}`,
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

// Add diagnostic function for wallet troubleshooting
async function diagnoseTradingWallet(): Promise<void> {
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

// Enhanced bot operation tracking helper
async function trackBotOperation(
  operationType: 'buy' | 'sell',
  token: any,
  bestResult: TradeExecutionResult,
  isSimulated: boolean,
  strategy: string = 'auto-trending'
): Promise<void> {
  try {
    const { getSolPriceUSD } = await import('@/utils/solana')
    const {
      buildTradingRecord,
      insertTradingRecord,
    } = await import('@/utils/trading-records-db')

    const currentSolPrice = await getSolPriceUSD()
    const walletAddress = tradingKeypair?.publicKey.toString() || 'simulation'
    const tokenDecimals = 6

    const solAmount =
      operationType === 'buy'
        ? bestResult.inputAmount
          ? parseFloat(bestResult.inputAmount) / 1e9
          : getBuyAmountForStrategy(strategy)
        : parseFloat(bestResult.outputAmount) / 1e9

    const tokenAmount =
      operationType === 'buy'
        ? parseFloat(bestResult.outputAmount) / Math.pow(10, tokenDecimals)
        : parseFloat(bestResult.inputAmount) / Math.pow(10, tokenDecimals)

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

// Add new Discord notification for synchronized trade results
async function sendSyncTradeNotificationDiscord(params: {
  tokenSymbol: string | null
  tokenAddress: string
  operationType: 'buy' | 'sell'
  syncResult: SyncedTradeResult
  isRealTradeExecuted: boolean
  tokenData?: any
}) {
  try {
    if (!shouldEnableNotifications()) {
      logTradeOperation('Discord Sync Notification Skipped', {
        reason: 'Notifications disabled',
        webhookStatus: 'not configured'
      })
      return
    }

    const {
      tokenSymbol,
      tokenAddress,
      operationType,
      syncResult,
      isRealTradeExecuted,
      tokenData
    } = params

    logTradeOperation('Discord Sync Notification Attempt', {
      tokenSymbol,
      tokenAddress,
      operationType,
      isRealTradeExecuted,
      hasDeviation: !!syncResult.deviation
    })

    const emoji = operationType === 'buy' ? '💰' : '💸'
    const title = `${emoji} ${operationType.toUpperCase()} Sync Results`

    const lines = [
      `🔄 **${title}**`,
      ``,
      `🪙 **${tokenSymbol || 'UNKNOWN'}**`,
      `📊 **Simulation Result:**`,
      `  ✅ Success: ${syncResult.simulation.success}`,
      `  🎯 Output: ${parseFloat(syncResult.simulation.outputAmount).toLocaleString()} ${operationType === 'buy' ? 'tokens' : 'SOL'}`,
      `  💸 Fees: ${syncResult.simulation.fees.totalFees.toFixed(6)} SOL`,
      `  ⏱️ Time: ${syncResult.simulation.responseTime}ms`,
      ``
    ]

    if (isRealTradeExecuted && syncResult.real) {
      lines.push(
        `🔥 **Real Trade Result:**`,
        `  ✅ Success: ${syncResult.real.success}`,
        `  🎯 Output: ${parseFloat(syncResult.real.outputAmount).toLocaleString()} ${operationType === 'buy' ? 'tokens' : 'SOL'}`,
        `  💸 Fees: ${syncResult.real.fees.totalFees.toFixed(6)} SOL`,
        `  ⏱️ Time: ${syncResult.real.responseTime}ms`,
      )

      // Add market cap, graduatedAt, and launchpad data
      if (tokenData) {
        if (tokenData.market_cap) {
          lines.push(`  📊 Market Cap: $${tokenData.market_cap.toLocaleString()}`)
        }
        if (tokenData.graduatedAt) {
          lines.push(`  🎓 Graduated: ${new Date(tokenData.graduatedAt).toLocaleDateString()}`)
        } else {
          console.log(`⚠️ No graduatedAt data for token: ${tokenSymbol || 'UNKNOWN'}`)
        }
        if (tokenData.launchpad) {
          lines.push(`  🚀 Launchpad: ${tokenData.launchpad}`)
        } else {
          console.log(`⚠️ No launchpad data for token: ${tokenSymbol || 'UNKNOWN'}`)
        }
      } else {
        console.log(`⚠️ No tokenData available for token: ${tokenSymbol || 'UNKNOWN'}`)
      }

      lines.push(``)

      console.warn('Real trade executed', lines)

      if (syncResult.real.signature) {
        lines.push(`🔗 Signature: \`${syncResult.real.signature}\``)
        lines.push(`📍 [View on Solscan](https://solscan.io/tx/${syncResult.real.signature})`)
        lines.push(``)
      }
    } else {
      lines.push(`💻 **Real Trade:** Not executed (simulation only)`, ``)
    }

    // Add deviation analysis if available
    if (syncResult.deviation && isRealTradeExecuted) {
      const deviation = syncResult.deviation
      const deviationEmoji = deviation.outputAmountDiffPercent > 5 ? '⚠️' : '✅'

      lines.push(
        `${deviationEmoji} **Synchronization Analysis:**`,
        `  📈 Output Deviation: ${deviation.outputAmountDiffPercent.toFixed(2)}%`,
        `  💰 Amount Diff: ${deviation.outputAmountDiff.toFixed(6)}`,
        `  💸 Fees Diff: ${deviation.feesDiff.toFixed(6)} SOL`,
        `  ⏱️ Time Diff: ${deviation.responseTimeDiff}ms`,
        ``
      )

      console.warn('Real trade executed with deviation', lines)

      // Add interpretation
      if (deviation.outputAmountDiffPercent > 10) {
        lines.push(`🚨 **HIGH DEVIATION DETECTED** - Investigate quote timing or slippage`)
      } else if (deviation.outputAmountDiffPercent > 5) {
        lines.push(`⚠️ **Moderate deviation** - Monitor for patterns`)
      } else {
        lines.push(`✅ **Good synchronization** - Results align well`)
      }
      lines.push(``)
    }

    lines.push(`⏰ ${new Date().toLocaleString()}`)

    const content = lines.join('\n')

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

    logTradeOperation('Discord Sync Notification Success', {
      tokenSymbol,
      operationType,
      isRealTradeExecuted,
      responseTime: webhookResponseTime,
      httpStatus: response.status
    })
  } catch (err) {
    logTradeOperation('Discord Sync Notification Error', {
      tokenSymbol: params.tokenSymbol,
      operationType: params.operationType,
      isRealTradeExecuted: params.isRealTradeExecuted
    }, err as Error)

    throw err
  }
}

// Discord notification for significant deviations summary
async function sendSignificantDeviationsAlertDiscord(params: {
  tokenSymbol: string | null
  tokenAddress: string
  deviations: SyncedTradeResult[]
  operationType: 'buy' | 'sell'
}) {
  try {
    if (!shouldEnableNotifications()) {
      return
    }

    const { tokenSymbol, tokenAddress, deviations, operationType } = params

    logTradeOperation('Discord Significant Deviations Alert', {
      tokenSymbol,
      operationType,
      deviationCount: deviations.length
    })

    const lines = [
      `🚨 **SIGNIFICANT DEVIATIONS DETECTED**`,
      ``,
      `🪙 **${tokenSymbol || 'UNKNOWN'}** (${operationType.toUpperCase()})`,
      `📊 **${deviations.length} deviation(s) > 5%**`,
      ``
    ]

    // Add details for each significant deviation
    deviations.forEach((deviation, index) => {
      if (deviation.deviation && deviation.deviation.outputAmountDiffPercent > 5) {
        lines.push(
          `**Deviation ${index + 1}:**`,
          `  📈 Output Diff: ${deviation.deviation.outputAmountDiffPercent.toFixed(2)}%`,
          `  💰 Amount Diff: ${deviation.deviation.outputAmountDiff.toFixed(6)}`,
          `  💸 Fees Diff: ${deviation.deviation.feesDiff.toFixed(6)} SOL`,
          ``
        )
      }
    })

    // Add recommendations
    lines.push(
      `🔍 **Possible Causes:**`,
      `• Quote timing differences`,
      `• Network latency variations`,
      `• Slippage calculation differences`,
      `• Market volatility during execution`,
      ``,
      `💡 **Recommended Actions:**`,
      `• Review quote timing synchronization`,
      `• Check RPC latency patterns`,
      `• Monitor market conditions during trades`,
      ``,
      `⏰ ${new Date().toLocaleString()}`
    )

    const content = lines.join('\n')

    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    })

    if (!response.ok) {
      throw new Error(`Discord webhook failed: ${response.status}`)
    }

    logTradeOperation('Discord Significant Deviations Alert Success', {
      tokenSymbol,
      operationType,
      deviationCount: deviations.length
    })
  } catch (err) {
    logTradeOperation('Discord Significant Deviations Alert Error', {
      tokenSymbol: params.tokenSymbol,
      operationType: params.operationType
    }, err as Error)
  }
}

function getBuyAmountForStrategy(strategyId?: string): number {
  // Check for global environment override first
  const envBuyAmount = process.env.BUY_AMOUNT_SOL
  if (envBuyAmount) {
    const amount = parseFloat(envBuyAmount)
    if (!isNaN(amount) && amount > 0 && amount <= 1.0) { // Max 1 SOL safety limit
      console.log(`💰 Using environment override BUY_AMOUNT_SOL: ${amount} SOL`)
      return amount
    } else {
      console.warn(`⚠️ Invalid BUY_AMOUNT_SOL environment value: ${envBuyAmount}, using strategy default`)
    }
  }

  // Check for strategy-specific environment override
  if (strategyId) {
    const strategyEnvKey = `BUY_AMOUNT_SOL_${strategyId.toUpperCase()}`
    const strategyEnvAmount = process.env[strategyEnvKey]
    if (strategyEnvAmount) {
      const amount = parseFloat(strategyEnvAmount)
      if (!isNaN(amount) && amount > 0 && amount <= 1.0) {
        console.log(`💰 Using strategy-specific override ${strategyEnvKey}: ${amount} SOL`)
        return amount
      } else {
        console.warn(`⚠️ Invalid ${strategyEnvKey} environment value: ${strategyEnvAmount}, using strategy default`)
      }
    }
  }

  // Use strategy-specific buy amount
  const strategy = getTradingStrategy(strategyId)
  console.log(`💰 Using ${strategy.name} buy amount: ${strategy.buy_amount_sol} SOL`)
  return strategy.buy_amount_sol
}

// Helper function to get priority fee for strategy with environment override
function getPriorityFeeForStrategy(strategyId?: string): number {
  // Check for global environment override first
  const envPriorityFee = process.env.PRIORITY_FEE_LAMPORTS
  if (envPriorityFee) {
    const fee = parseInt(envPriorityFee)
    if (!isNaN(fee) && fee >= 0 && fee <= 1000000) { // Max 0.001 SOL safety limit
      console.log(`⚡ Using environment override PRIORITY_FEE_LAMPORTS: ${fee} lamports`)
      return fee
    } else {
      console.warn(`⚠️ Invalid PRIORITY_FEE_LAMPORTS environment value: ${envPriorityFee}, using strategy default`)
    }
  }

  // Check for strategy-specific environment override
  if (strategyId) {
    const strategyEnvKey = `PRIORITY_FEE_LAMPORTS_${strategyId.toUpperCase()}`
    const strategyEnvFee = process.env[strategyEnvKey]
    if (strategyEnvFee) {
      const fee = parseInt(strategyEnvFee)
      if (!isNaN(fee) && fee >= 0 && fee <= 1000000) {
        console.log(`⚡ Using strategy-specific override ${strategyEnvKey}: ${fee} lamports`)
        return fee
      } else {
        console.warn(`⚠️ Invalid ${strategyEnvKey} environment value: ${strategyEnvFee}, using strategy default`)
      }
    }
  }

  // Use strategy-specific priority fee
  const strategy = getTradingStrategy(strategyId)
  console.log(`⚡ Using ${strategy.name} priority fee: ${strategy.priority_fee_lamports} lamports`)
  return strategy.priority_fee_lamports
}

// Strategy-aware buy operation execution
async function executeBuyOperationWithStrategy(
  token: any,
  strategyId: string,
  operationType: 'simulation' | 'real' = 'simulation',
  simulation: TradingSimulation
): Promise<BuyOperation | null> {
  const strategy = getTradingStrategy(strategyId)
  console.log(`🎯 Executing buy operation for ${token.token_symbol} using ${strategy.name} strategy`)
  const isSimulated = operationType === 'simulation'

  try {
    console.log(`💰 Performing synchronized buy ${operationType} for ${token.token_symbol} (${token.token_address})`)

    // SOL mint address and trading parameters
    const SOL_MINT = 'So11111111111111111111111111111111111111112'
    let BUY_AMOUNT_SOL = getBuyAmountForStrategy(strategyId) // Dynamic based on strategy
    let PRIORITY_FEE_SOL = getPriorityFeeForStrategy(strategyId) // Dynamic based on strategy

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
    // const PRIORITY_FEE_SOL = 0.001 // 0.001 SOL priority fee as specified
    const PRIORITY_FEE_LAMPORTS = Math.floor(PRIORITY_FEE_SOL * 1e9)

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
    }

    return null
  }
}

// Unified sell operation (supports both simulation and real trading)
async function performSellOperation(
  token: any,
  simulation: TradingSimulation,
  sellPercentage: number,
  strategyId?: string
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
      bot_strategy: getCurrentBotStrategy(),
      signature: bestResult.signature
    }

    // Update simulation's remaining token amount
    simulation.remaining_token_amount = remainingTokens

    // Track bot sell operation in the trading tracker system
    if (bestResult.success) {
      try {
        const currentStrategy = getCurrentBotStrategy()
        await trackBotOperation('sell', token, bestResult, isSimulated, currentStrategy)
      } catch (trackError) {
        console.error('❌ Failed to track bot sell operation:', trackError)
        // Don't fail the operation if tracking fails
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
function shouldSellToken(token: TrackedToken, simulation: TradingSimulation): { shouldSell: boolean, sellPercentage: number, reason: string } {
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

  // Check stop loss (-50%)
  if (currentGain <= simulation.stop_loss_percentage) {
    console.log(`🛑 STOP LOSS TRIGGERED for ${token.token_symbol}: ${currentGain.toFixed(2)}% <= ${simulation.stop_loss_percentage}%`)
    return {
      shouldSell: true,
      sellPercentage: 100, // Sell everything
      reason: `🛑 Stop loss triggered: ${currentGain.toFixed(2)}% <= ${simulation.stop_loss_percentage}%`
    }
  }

  // Check TP1 (80%) - Sell 80% of position
  if (!hasTP1 && currentGain >= simulation.take_profit_levels.tp1_percentage) {
    console.log(`🎯 TP1 TRIGGERED for ${token.token_symbol}: ${currentGain.toFixed(2)}% >= ${simulation.take_profit_levels.tp1_percentage}%`)
    return {
      shouldSell: true,
      sellPercentage: simulation.take_profit_levels.tp1_sell_percentage,
      reason: `🎯 TP1 reached: ${currentGain.toFixed(2)}% >= ${simulation.take_profit_levels.tp1_percentage}%`
    }
  }

  // Check TP2 (100%) - Sell remaining position
  if (hasTP1 && currentGain >= simulation.take_profit_levels.tp2_percentage) {
    console.log(`🎯 TP2 TRIGGERED for ${token.token_symbol}: ${currentGain.toFixed(2)}% >= ${simulation.take_profit_levels.tp2_percentage}%`)
    return {
      shouldSell: true,
      sellPercentage: 100,
      reason: `🎯 TP2 reached: ${currentGain.toFixed(2)}% >= ${simulation.take_profit_levels.tp2_percentage}%`
    }
  }

  // Check TP3 (30% after TP1) - Sell remaining position
  if (hasTP1 && simulation.take_profit_levels.tp3_enabled && currentGain <= simulation.take_profit_levels.tp3_percentage) {
    console.log(`📉 TP3 TRIGGERED for ${token.token_symbol}: ${currentGain.toFixed(2)}% <= ${simulation.take_profit_levels.tp3_percentage}% after TP1`)
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

// Get manual position data from trading tracker
async function getManualPositionData(mintAddress: string, currentBalance: number): Promise<{
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
async function checkForManualPositionsAndSL(tokens: TrackedToken[]): Promise<void> {
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
async function executeManualPositionSL(
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

// Add endpoint to toggle trading mode and test Discord notifications
export const PUT = withUnifiedLogging(async (request: NextRequest, logger) => {
  try {
    const { searchParams } = new URL(request.url)
    const secretKey = searchParams.get('key')
    const expectedSecretKey = process.env.TRENDING_TRACKER_SECRET || 'r3l0ads0l-trending'
    const testDiscord = searchParams.get('test') === 'discord'
    const testFilter = searchParams.get('test') === 'filter'

    if (secretKey !== expectedSecretKey) {
      logger.warn('api_request', 'Unauthorized attempt to change trading mode', {
        ip: request.headers.get('x-forwarded-for') ||
          request.headers.get('x-real-ip') ||
          'unknown',
      })
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (testFilter) {
      try {
        console.log('Track Filter Test: Starting enhanced filtering test...')

        // Fetch trending tokens from Jupiter API (same logic as main tracking)
        const JUPITER_TRENDING_URLS = [
          'https://datapi.jup.ag/v1/pools/toptrending/1h',
        ]

        let response: Response | null = null

        for (const url of JUPITER_TRENDING_URLS) {
          try {
            console.log(`Fetching trending tokens from: ${url}`)
            response = await fetch(url, {
              headers: {
                'Accept': 'application/json',
                'User-Agent': 'ReloadSol-TrendingTracker/1.0'
              },
              next: { revalidate: 0 }
            })

            if (response.ok) {
              console.log(`✅ Successfully fetched from ${url}`)
              break
            }

            if (response.status === 429) {
              console.log(`⏳ Rate limited on ${url}, waiting 500ms...`)
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
        console.log(`Track Filter Test: Fetched ${data.pools.length} pools from Jupiter API`)

        // Perform enhanced filtering
        const currentStrategy = getCurrentBotStrategy()
        const customFilterConfig = parseCustomFilterConfig()
        const { results: filterResults, summary: filteringSummary } = await performEnhancedFiltering(
          data.pools,
          currentStrategy,
          customFilterConfig || {}
        )

        // Extract accepted tokens
        const acceptedTokens = filterResults
          .filter(result => result.passed)
          .map(result => ({
            address: result.token.baseAsset.id,
            symbol: result.token.baseAsset.symbol,
            name: result.token.baseAsset.name,
            marketCap: result.token.baseAsset.mcap,
            volume1h: result.token.baseAsset.stats1h?.buyVolume || 0,
            organicScore: result.token.baseAsset.organicScore,
            currentPrice: result.token.baseAsset.usdPrice,
            priceChange1h: result.token.baseAsset.stats1h?.priceChange || 0,
            priceChange5m: result.token.baseAsset.stats5m?.priceChange || 0,
            priceChange6h: result.token.baseAsset.stats6h?.priceChange || 0
          }))

        // Extract rejected tokens with their rejection reasons
        const rejectedTokens = filterResults
          .filter(result => !result.passed)
          .map(result => ({
            address: result.token.baseAsset.id,
            symbol: result.token.baseAsset.symbol,
            name: result.token.baseAsset.name,
            marketCap: result.token.baseAsset.mcap,
            volume1h: result.token.baseAsset.stats1h?.buyVolume || 0,
            organicScore: result.token.baseAsset.organicScore,
            currentPrice: result.token.baseAsset.usdPrice,
            priceChange1h: result.token.baseAsset.stats1h?.priceChange || 0,
            priceChange5m: result.token.baseAsset.stats5m?.priceChange || 0,
            priceChange6h: result.token.baseAsset.stats6h?.priceChange || 0,
            rejectionReasons: result.rejectionReasons
          }))

        const summary = {
          totalTokens: data.pools.length,
          acceptedCount: acceptedTokens.length,
          rejectedCount: rejectedTokens.length,
          acceptanceRate: `${((acceptedTokens.length / data.pools.length) * 100).toFixed(1)}%`,
          processingTime: filteringSummary.processingTime
        }

        console.log('Track Filter Test: Filtering completed successfully', summary)

        return NextResponse.json({
          success: true,
          message: 'Track filter test completed successfully',
          summary,
          acceptedTokens,
          rejectedTokens,
          rejectionDetails: filteringSummary.rejectionDetails
        })

      } catch (error) {
        console.error('Track Filter Test: Error during filtering test', error)
        return NextResponse.json({
          success: false,
          message: 'Track filter test failed',
          error: error instanceof Error ? error.message : 'Unknown error'
        }, { status: 500 })
      }
    }

    // Handle Discord testing
    if (testDiscord) {
      // Check Discord configuration
      const discordEnabled = shouldEnableNotifications()
      const webhookUrl = DISCORD_WEBHOOK_URL

      console.log('Track Discord Configuration Test:', {
        discordEnabled,
        webhookConfigured: !!webhookUrl,
        webhookUrl: webhookUrl ? `${webhookUrl.substring(0, 50)}...` : 'Not configured',
        env: {
          DISCORD_WEBHOOK_AUTO_TRADE: !!process.env.DISCORD_WEBHOOK_AUTO_TRADE,
          DISCORD_WEBHOOK_URL: !!process.env.DISCORD_WEBHOOK_URL,
          ENABLE_DISCORD_NOTIFICATIONS: process.env.ENABLE_DISCORD_NOTIFICATIONS
        }
      })

      // Test different types of Discord notifications
      const testResults = []

      // Test 1: New Token Detection
      try {
        console.log('Testing new token detection notification...')
        await sendNewTokenDetectionDiscord({
          tokenAddress: 'TESTDISCORD1234567890',
          tokenSymbol: 'DTEST',
          tokenName: 'Discord Test Token',
          currentPrice: 0.000123,
          marketCap: 500000,
          organicScore: 85.5,
          volume1h: 25000,
          isRealTrading: false
        })
        testResults.push({ type: 'new_token_detection', success: true })
        console.log('New token detection test: SUCCESS')
      } catch (error) {
        testResults.push({
          type: 'new_token_detection',
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
        console.error('New token detection test: FAILED', error)
      }

      // Test 2: Buy Notification
      try {
        console.log('Testing buy notification...')
        await sendBuyNotificationDiscord({
          tokenSymbol: 'DTEST',
          tokenAddress: 'TESTDISCORD1234567890',
          isSimulated: true,
          amountSOL: 0.1,
          tokensReceived: '1000000',
          priceUSD: 0.000123,
          provider: 'jupiter',
          rpcUsed: 'test-rpc',
          responseTime: 150,
          totalFees: 0.001,
          marketCap: 50000,
          riskAssessment: {
            riskLevel: 'LOW',
            assessmentMethod: 'test'
          },
          graduatedAt: '2025-01-10T12:56:39Z'
        })
        testResults.push({ type: 'buy_notification', success: true })
        console.log('Buy notification test: SUCCESS')
      } catch (error) {
        testResults.push({
          type: 'buy_notification',
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
        console.error('Buy notification test: FAILED', error)
      }

      // Test 3: Trade Alert
      try {
        console.log('Testing trade alert notification...')
        await sendTradeAlertDiscord({
          tokenSymbol: 'TEST',
          status: 'buy' as any,
          isSimulated: true,
          currentGain: 15.5,
          peakGain: 20.2,
          priceUsd: 0.000145,
          provider: 'jupiter',
          rpcUsed: 'test-rpc',
          responseTime: 200
        })
        testResults.push({ type: 'trade_alert', success: true })
        console.log('Trade alert test: SUCCESS')
      } catch (error) {
        testResults.push({
          type: 'trade_alert',
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
        console.error('Trade alert test: FAILED', error)
      }

      const successCount = testResults.filter(r => r.success).length
      const totalTests = testResults.length

      return NextResponse.json({
        success: true,
        message: 'Track Discord configuration test completed',
        discord: {
          enabled: discordEnabled,
          webhookConfigured: !!webhookUrl,
          testResults,
          summary: `${successCount}/${totalTests} tests passed`
        },
        environment: {
          NODE_ENV: process.env.NODE_ENV,
          DISCORD_WEBHOOK_AUTO_TRADE: !!process.env.DISCORD_WEBHOOK_AUTO_TRADE,
          DISCORD_WEBHOOK_URL: !!process.env.DISCORD_WEBHOOK_URL,
          ENABLE_DISCORD_NOTIFICATIONS: process.env.ENABLE_DISCORD_NOTIFICATIONS
        }
      })
    }

    const body = await request.json()
    const { isSimulated, keypairPath } = body

    if (typeof isSimulated !== 'boolean') {
      logger.warn('api_request', 'Invalid body for trading mode change', { body })
      return NextResponse.json({ error: 'isSimulated must be a boolean' }, { status: 400 })
    }

    if (!isSimulated && !keypairPath && !process.env.TRADING_KEYPAIR_JSON) {
      logger.error('api_request', 'Trading keypair not configured for real mode')
      return NextResponse.json({ error: 'Trading keypair not configured. Provide keypairPath or set TRADING_KEYPAIR_JSON' }, { status: 400 })
    }

    await setTradingMode(isSimulated, keypairPath)
    logger.info('api_request', `Trading mode changed to ${isSimulated ? 'simulated' : 'real'}`)

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

        logger.info('discord_notification', 'Discord notification sent for trading mode change')
      } catch (discordError) {
        logger.error('discord_notification', 'Failed to send Discord notification for trading mode change', discordError as Error)
        // Don't fail the operation if Discord fails
      }
    }

    return NextResponse.json({
      success: true,
      mode: isSimulated ? 'simulated' : 'real',
      message: `Successfully switched to ${isSimulated ? 'simulated' : 'real'} trading mode`
    })

  } catch (error) {
    logger.critical('api_request', 'Error in PUT /api/trending/track', error as Error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
})

function isWithinTradingHours(): { allowed: boolean; reason?: string; currentTime?: string } {
  const now = new Date()

  // Convert to GMT+7 (Asia/Bangkok timezone)
  const gmt7Time = new Date(now.getTime() + (7 * 60 * 60 * 1000))
  const hours = gmt7Time.getUTCHours()
  const minutes = gmt7Time.getUTCMinutes()
  const timeString = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')} GMT+7`

  // Trading allowed from 16:00 to 04:00 GMT+7
  // This means: 15:00-23:59 and 00:00-05:59
  const isAllowed = hours >= 15 || hours < 6

  return {
    allowed: isAllowed,
    reason: isAllowed ? undefined : `Trading restricted outside 16:00-04:00 GMT+7. Current time: ${timeString}`,
    currentTime: timeString
  }
}

/**
 * Checks if the current day is a weekend (Saturday or Sunday) or weekday (Monday-Friday)
 * @returns Object with day type information
 */
function isDayTypeWeekend(): { isWeekend: boolean; dayType: 'weekend' | 'weekday'; dayName: string } {
  const now = new Date()

  // Convert to GMT+7 (Asia/Bangkok timezone) to match the isWithinTradingHours function
  const gmt7Time = new Date(now.getTime() + (7 * 60 * 60 * 1000))
  const dayOfWeek = gmt7Time.getUTCDay() // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

  // Weekend is Saturday (6) or Sunday (0)
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6

  // Get day name for logging
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const dayName = dayNames[dayOfWeek]

  return {
    isWeekend,
    dayType: isWeekend ? 'weekend' : 'weekday',
    dayName
  }
}

async function internalTrackPost(request: NextRequest, logger: any) {
  const requestStartTime = Date.now()
  const requestId = Math.random().toString(36).substring(7)

  try {
    // Log incoming request
    logger.info('api_request', 'Tracking Request Started', {
      userAgent: request.headers.get('user-agent'),
      source: request.headers.get('user-agent')?.includes('reloadsol-cron-service') ? 'cron' : 'browser'
    })

    // Log strategy status at startup
    const strategyStatus = getStrategyStatusSummary()
    console.log(`🎯 Strategy Status Summary:`)
    console.log(`  ✅ Active (${strategyStatus.is_active.length}): ${strategyStatus.is_active.join(', ') || 'none'}`)
    console.log(`  ❌ Inactive (${strategyStatus.is_inactive.length}): ${strategyStatus.is_inactive.join(', ') || 'none'}`)
    console.log(`  📊 Total: ${strategyStatus.total} strategies`)

    // Get active strategies with their configurations
    const { strategies: activeStrategies, configs: activeConfigs, allocation } = getActiveStrategiesWithState()

    if (activeStrategies.length === 0) {
      throw new Error('No active strategies available for trading')
    }

    console.log(`🚀 Starting trading cycle with ${activeStrategies.length} active strategies`)

    // Validate authentication (server-side only)
    const { searchParams } = new URL(request.url)
    const secretKey = searchParams.get('key')
    const expectedSecretKey = process.env.TRENDING_TRACKER_SECRET || 'r3l0ads0l-trending'

    // Allow calls from:
    // 1. Vercel cron jobs (internal calls)
    // 2. Localhost in development (no secret needed)
    // 3. Valid secret key (manual/external calls)
    const isDevelopment = process.env.NODE_ENV === 'development'
    const isLocalhost = request.headers.get('host')?.includes('localhost') || request.headers.get('host')?.includes('127.0.0.1')

    if (isDevelopment && isLocalhost && !secretKey) {
      console.log('🔓 Development mode: allowing combined tracking+summary API call without secret key')
    } else if (secretKey !== expectedSecretKey) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Check trading hours restriction
    const timeCheck = isWithinTradingHours()
    if (!timeCheck.allowed) {
      console.log(`⏰ ${timeCheck.reason}`)

      // Send Discord notification about time restriction
      if (shouldEnableNotifications()) {
        try {
          const content = [
            `⏰ Trading Request Rejected - Outside Trading Hours`,
            ``,
            `Current Time: ${timeCheck.currentTime}`,
            `Trading Hours: 16:00 - 04:00 GMT+7`,
            `Reason: ${timeCheck.reason}`,
            ``,
            `⏰ ${new Date().toLocaleString()}`
          ].join('\n')

          await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
          })

          logger.info('discord_notification', 'Discord notification sent for time restriction')
        } catch (discordError) {
          logger.error('discord_notification', 'Failed to send Discord notification for time restriction', discordError as Error)
        }
      }

      return NextResponse.json({
        error: 'Trading not allowed at this time',
        message: timeCheck.reason,
        currentTime: timeCheck.currentTime,
        tradingHours: '16:00 - 04:00 GMT+7',
        timestamp: new Date().toISOString()
      }, { status: 403 })
    }

    console.log(`✅ Trading allowed at ${timeCheck.currentTime}`)

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

    // Enhanced filtering with comprehensive tracking
    console.log(`🔍 Starting enhanced token filtering for ${data.pools.length} tokens...`)
    const currentStrategy = getCurrentBotStrategy()
    const customFilterConfig = parseCustomFilterConfig()

    // Add debug logging for strategy and configuration
    console.log(`🎯 Current strategy: ${currentStrategy}`)
    if (customFilterConfig && Object.keys(customFilterConfig).length > 0) {
      console.log(`🔧 Custom filter config:`, customFilterConfig)
    } else {
      const strategy = getTradingStrategy(currentStrategy)
      console.log(`🔧 Using strategy filter config:`, strategy.filtering)
    }

    const { results: filterResults, summary: filteringSummary } = await performEnhancedFiltering(
      data.pools,
      currentStrategy,
      customFilterConfig && Object.keys(customFilterConfig).length > 0 ? customFilterConfig : undefined
    )

    // Extract accepted tokens
    const filteredTokens = filterResults
      .filter(result => result.passed)
      .map(result => result.mappedToken)

    // Extract rejected tokens
    const rejectedTokens = filterResults.filter(result => !result.passed)

    console.log(`📊 Filtering complete: ${filteringSummary.acceptedTokens} accepted, ${filteringSummary.rejectedTokens} rejected`)

    // Determine if real trading is enabled
    const hasKeypair = !!process.env.TRADING_KEYPAIR_JSON
    const hasWebhook = !!process.env.DISCORD_WEBHOOK_AUTO_TRADE
    const isRealTrading = hasKeypair && hasWebhook

    try {
      log.info('discord_notification', 'Starting Discord filtering notifications', {
        totalTokens: filteringSummary.totalTokens,
        acceptedTokens: filteringSummary.acceptedTokens,
        rejectedTokens: filteringSummary.rejectedTokens,
        rejectedTokensArrayLength: rejectedTokens.length,
        isRealTrading
      })

      // Send filtering summary
      log.debug('discord_notification', 'Calling sendFilteringSummaryDiscord')
      await sendFilteringSummaryDiscord(filteringSummary, isRealTrading)
      log.info('discord_notification', 'sendFilteringSummaryDiscord completed successfully')

      // Send rejected tokens details (if any)
      if (rejectedTokens.length > 0) {
        log.debug('discord_notification', 'Calling sendRejectedTokensDiscord')
        await sendRejectedTokensDiscord(rejectedTokens, isRealTrading)
        log.info('discord_notification', 'sendRejectedTokensDiscord completed successfully')
      } else {
        log.warn('discord_notification', 'No rejected tokens to send Discord notification for')
      }

      log.info('discord_notification', 'All Discord filtering notifications completed successfully')
    } catch (discordError) {
      log.error('discord_notification', 'Error sending Discord filtering notifications', discordError as Error, {
        message: discordError instanceof Error ? discordError.message : String(discordError),
        stack: discordError instanceof Error ? discordError.stack : undefined
      })
      // Continue processing even if Discord notifications fail
    }

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
         waiting_started_at, waiting_initial_price, volume_5m, status_changed_at, created_at`
      )
      .in('status', ['tracking', 'waiting'])

    // Check for manual sells before processing new tokens
    if (trackedTokens && trackedTokens.length > 0) {
      try {
        // await checkForManualSells(trackedTokens as TrackedToken[])
        await checkForManualPositionsAndSL(trackedTokens as TrackedToken[])
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

    // Assign strategies to filtered tokens
    console.log(`🎯 Assigning strategies to ${filteredTokens.length} filtered tokens...`)

    // Use the already fetched active strategies from startup
    initializeStrategyTracking(activeStrategies)

    // Group tokens by assigned strategy
    const tokensByStrategy = new Map<string, any[]>()
    activeStrategies.forEach(strategyId => tokensByStrategy.set(strategyId, []))

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

          const { strategies: activeStrategies } = getActiveStrategies()
          const strategyInfo = activeStrategies.length > 0 ? `[Strategies: ${activeStrategies.join(', ')}]` : '[No active strategies]'
          console.warn(`⏭️ Token ${token.token_symbol}, from strategy:${strategyInfo} already exists in database. Skipping duplicate`)
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
            // Check if real trading mode is activated - improved logic
            let isRealTradingActive = false
            let keypairPath: string | undefined = undefined

            // First, check if TRADING_KEYPAIR_JSON environment variable is set
            const hasEnvKeypair = !!process.env.TRADING_KEYPAIR_JSON
            console.log(`🔑 Keypair detection for ${token.token_symbol}:`)
            console.log(`  - TRADING_KEYPAIR_JSON env var: ${hasEnvKeypair ? 'SET' : 'NOT SET'}`)

            // Check if any existing tracked token has real trading enabled
            const existingRealTradeTokens = trackedTokens?.filter(t =>
              t.trading_simulation && !t.trading_simulation.is_simulated
            ) || []

            console.log(`  - Existing real trade tokens found: ${existingRealTradeTokens.length}`)

            // Find a token with both real trading AND a valid keypair_path
            const validRealTradeToken = existingRealTradeTokens.find(t =>
              t.trading_simulation?.keypair_path
            )

            if (validRealTradeToken?.trading_simulation) {
              console.log(`  - Valid existing token with keypair found: ${validRealTradeToken.token_symbol}`)
            }

            // Determine trading mode and keypair path with better validation
            if (hasEnvKeypair) {
              // Environment variable is available - use real trading
              isRealTradingActive = true
              keypairPath = undefined // Will use environment variable
              console.log(`🔥 Real trading mode detected via TRADING_KEYPAIR_JSON - new token ${token.token_symbol} will use REAL trading`)
            } else if (validRealTradeToken?.trading_simulation?.keypair_path) {
              // Copy from existing token that has valid keypair
              isRealTradingActive = true
              keypairPath = validRealTradeToken.trading_simulation.keypair_path
              console.log(`🔥 Real trading mode detected via existing token ${validRealTradeToken.token_symbol} - new token ${token.token_symbol} will use REAL trading`)
            } else {
              // No valid keypair configuration found - use simulation
              if (existingRealTradeTokens.length > 0) {
                console.warn(`⚠️ Found ${existingRealTradeTokens.length} tokens with real trading enabled but no valid keypair_path!`)
                console.warn(`⚠️ This indicates a configuration issue. Falling back to simulation mode for ${token.token_symbol}`)
              } else {
                console.log(`💻 No real trading configuration found - new token ${token.token_symbol} will use simulation`)
              }
              isRealTradingActive = false
              keypairPath = undefined
            }

            // Perform comprehensive risk assessment before assignment
            let riskAssessment: any
            try {
              riskAssessment = await assessTokenRisk({
                token_address: token.token_address,
                token_symbol: token.token_symbol,
                mcap: token.market_cap,
                price: token.current_price,
                change_1h: token.change_1h,
                change_5m: token.change_5m,
                organic_score: token.organic_score
              }, { enableLogging: true, fallbackToBasic: true })

              console.log(`🔍 Risk assessment for ${token.token_symbol}: ${riskAssessment.riskLevel} (method: ${riskAssessment.assessmentMethod})`)
            } catch (riskError) {
              console.error(`❌ Risk assessment failed for ${token.token_symbol}:`, riskError)
              riskAssessment = { riskLevel: 'HIGH', assessmentMethod: 'error_fallback' }
            }

            // Assign token to strategy
            const assignedStrategy = assignTokenToStrategy(token, activeStrategies, allocation)

            // Enforce strategy-specific constraints before proceeding
            const strategy = getTradingStrategy(assignedStrategy)

            // Market cap constraints
            if (strategy.conditions?.min_market_cap && token.market_cap < strategy.conditions.min_market_cap) {
              console.log(`🚫 Token ${token.token_symbol} rejected by strategy '${assignedStrategy}': Market cap $${(token.market_cap / 1000).toFixed(0)}k below minimum $${(strategy.conditions.min_market_cap / 1000).toFixed(0)}k`)
              continue
            }
            if (strategy.conditions?.max_market_cap && token.market_cap > strategy.conditions.max_market_cap) {
              console.log(`🚫 Token ${token.token_symbol} rejected by strategy '${assignedStrategy}': Market cap $${(token.market_cap / 1000000).toFixed(2)}M above maximum $${(strategy.conditions.max_market_cap / 1000).toFixed(0)}k`)
              continue
            }

            // Risk level constraints - using comprehensive risk assessment
            if (strategy.conditions?.max_risk_level && riskAssessment) {
              const tokenRisk = riskAssessment.riskLevel.toLowerCase() // Convert uppercase to lowercase
              const allowedRisks = strategy.conditions.max_risk_level === 'low' ? ['low'] :
                strategy.conditions.max_risk_level === 'medium' ? ['low', 'med'] :
                  ['low', 'med', 'high']

              if (!allowedRisks.includes(tokenRisk)) {
                console.log(`🚫 Token ${token.token_symbol} rejected by strategy '${assignedStrategy}': Risk level ${riskAssessment.riskLevel} exceeds maximum ${strategy.conditions.max_risk_level.toUpperCase()} (assessment: ${riskAssessment.assessmentMethod})`)
                continue
              } else {
                console.log(`✅ Token ${token.token_symbol} approved for strategy '${assignedStrategy}': Risk level ${riskAssessment.riskLevel} within allowed ${strategy.conditions.max_risk_level.toUpperCase()} threshold`)
              }
            }

            // Create initial simulation configuration (use detected trading mode)
            const initialSimulation = createTradingSimulation(
              token,
              assignedStrategy, // Use assigned strategy instead of environment variable
              isRealTradingActive,
              keypairPath,
              new Date().toISOString()
            )

            // Perform buy operation using the strategy-aware system
            const buyOperation = await executeBuyOperationWithStrategy(
              token,
              assignedStrategy,
              isRealTradingActive ? 'real' : 'simulation',
              initialSimulation
            )

            if (buyOperation) {
              initialSimulation.buy_operation = buyOperation
              initialSimulation.current_status = 'holding'
              initialSimulation.remaining_token_amount = buyOperation.token_amount_received
              initialSimulation.initial_token_amount = buyOperation.token_amount_received
              tradingSimulation = initialSimulation

              console.log(`💰 Buy operation completed for ${token.token_symbol}: ${buyOperation.token_amount_received} tokens (${initialSimulation.is_simulated ? 'simulated' : 'real'}) using ${assignedStrategy} strategy`)

              // Add position to SL/TP tracker for real-time monitoring
              if (!initialSimulation.is_simulated && tradingKeypair) {
                try {
                  const strategy = getTradingStrategy(assignedStrategy)
                  await addSLTPPosition({
                    walletAddress: tradingKeypair.publicKey.toString(),
                    tokenAddress: token.token_address,
                    tokenSymbol: token.token_symbol,
                    positionSize: parseFloat(buyOperation.token_amount_received),
                    entryPrice: token.current_price,
                    stopLossPercentage: strategy.stop_loss_percentage,
                    takeProfitPercentage: strategy.take_profit_levels.tp2_percentage,
                    positionType: 'bot',
                    strategyId: assignedStrategy,
                    tp1Percentage: strategy.take_profit_levels.tp1_percentage,
                    tp1SellPercentage: strategy.take_profit_levels.tp1_sell_percentage,
                    tp2Percentage: strategy.take_profit_levels.tp2_percentage,
                    tp3Percentage: strategy.take_profit_levels.tp3_percentage,
                    tp3Enabled: strategy.take_profit_levels.tp3_enabled
                  })

                  console.log(`✅ Added ${token.token_symbol} to SL/TP tracker for real-time monitoring`)
                } catch (slTpError) {
                  console.error('❌ Failed to add position to SL/TP tracker:', slTpError)
                }
              }
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
              // Check if real trading mode is activated - improved logic
              let isRealTradingActive = false
              let keypairPath: string | undefined = undefined

              // First, check if TRADING_KEYPAIR_JSON environment variable is set
              const hasEnvKeypair = !!process.env.TRADING_KEYPAIR_JSON
              console.log(`🔑 Keypair detection for ${token.token_symbol}:`)
              console.log(`  - TRADING_KEYPAIR_JSON env var: ${hasEnvKeypair ? 'SET' : 'NOT SET'}`)

              // Check if any existing tracked token has real trading enabled
              const existingRealTradeTokens = trackedTokens?.filter(t =>
                t.trading_simulation && !t.trading_simulation.is_simulated
              ) || []

              console.log(`  - Existing real trade tokens found: ${existingRealTradeTokens.length}`)

              // Find a token with both real trading AND a valid keypair_path
              const validRealTradeToken = existingRealTradeTokens.find(t =>
                t.trading_simulation?.keypair_path
              )

              if (validRealTradeToken?.trading_simulation) {
                console.log(`  - Valid existing token with keypair found: ${validRealTradeToken.token_symbol}`)
              }

              // Determine trading mode and keypair path with better validation
              if (hasEnvKeypair) {
                // Environment variable is available - use real trading
                isRealTradingActive = true
                keypairPath = undefined // Will use environment variable
                console.log(`🔥 Real trading mode detected via TRADING_KEYPAIR_JSON - new token ${token.token_symbol} will use REAL trading`)
              } else if (validRealTradeToken?.trading_simulation?.keypair_path) {
                // Copy from existing token that has valid keypair
                isRealTradingActive = true
                keypairPath = validRealTradeToken.trading_simulation.keypair_path
                console.log(`🔥 Real trading mode detected via existing token ${validRealTradeToken.token_symbol} - new token ${token.token_symbol} will use REAL trading`)
              } else {
                // No valid keypair configuration found - use simulation
                if (existingRealTradeTokens.length > 0) {
                  console.warn(`⚠️ Found ${existingRealTradeTokens.length} tokens with real trading enabled but no valid keypair_path!`)
                  console.warn(`⚠️ This indicates a configuration issue. Falling back to simulation mode for ${token.token_symbol}`)
                } else {
                  console.log(`💻 No real trading configuration found - new token ${token.token_symbol} will use simulation`)
                }
                isRealTradingActive = false
                keypairPath = undefined
              }

              // Perform comprehensive risk assessment before assignment
              let riskAssessment: any
              try {
                riskAssessment = await assessTokenRisk({
                  token_address: token.token_address,
                  token_symbol: token.token_symbol,
                  mcap: token.market_cap,
                  price: token.current_price,
                  change_1h: token.change_1h,
                  change_5m: token.change_5m,
                  organic_score: token.organic_score
                }, { enableLogging: true, fallbackToBasic: true })
                console.log(`🔍 Risk assessment for ${token.token_symbol}: ${riskAssessment.riskLevel} (method: ${riskAssessment.assessmentMethod})`)
              } catch (riskError) {
                console.error(`❌ Risk assessment failed for ${token.token_symbol}:`, riskError)
                riskAssessment = { riskLevel: 'HIGH', assessmentMethod: 'error_fallback' }
              }

              // Assign token to strategy
              const assignedStrategy = assignTokenToStrategy(token, activeStrategies, allocation)

              // Enforce strategy-specific constraints before proceeding
              const strategy = getTradingStrategy(assignedStrategy)

              // Market cap constraints
              if (strategy.conditions?.min_market_cap && token.market_cap < strategy.conditions.min_market_cap) {
                console.log(`🚫 Token ${token.token_symbol} rejected by strategy '${assignedStrategy}': Market cap $${(token.market_cap / 1000).toFixed(0)}k below minimum $${(strategy.conditions.min_market_cap / 1000).toFixed(0)}k`)
                continue
              }
              if (strategy.conditions?.max_market_cap && token.market_cap > strategy.conditions.max_market_cap) {
                console.log(`🚫 Token ${token.token_symbol} rejected by strategy '${assignedStrategy}': Market cap $${(token.market_cap / 1000000).toFixed(2)}M above maximum $${(strategy.conditions.max_market_cap / 1000).toFixed(0)}k`)
                continue
              }

              // Risk level constraints - using comprehensive risk assessment
              if (strategy.conditions?.max_risk_level && riskAssessment) {
                const tokenRisk = riskAssessment.riskLevel.toLowerCase()
                const allowedRisks = strategy.conditions.max_risk_level === 'low' ? ['low'] :
                  strategy.conditions.max_risk_level === 'medium' ? ['low', 'med'] :
                    ['low', 'med', 'high']

                if (!allowedRisks.includes(tokenRisk)) {
                  console.log(`🚫 Token ${token.token_symbol} rejected by strategy '${assignedStrategy}': Risk level ${riskAssessment.riskLevel} exceeds maximum ${strategy.conditions.max_risk_level.toUpperCase()} (assessment: ${riskAssessment.assessmentMethod})`)
                  continue
                } else {
                  console.log(`✅ Token ${token.token_symbol} approved for strategy '${assignedStrategy}': Risk level ${riskAssessment.riskLevel} within allowed ${strategy.conditions.max_risk_level.toUpperCase()} threshold`)
                }
              }

              // Create initial simulation configuration (use detected trading mode)
              const initialSimulation = createTradingSimulation(
                token,
                assignedStrategy, // Use assigned strategy instead of environment variable
                isRealTradingActive,
                keypairPath,
                currentTime.toISOString()
              )

              // Override TP1 sell percentage for dip buys
              initialSimulation.take_profit_levels.tp1_sell_percentage = 95

              // Perform buy operation using the strategy-aware system
              const buyOperation = await executeBuyOperationWithStrategy(
                token,
                assignedStrategy,
                isRealTradingActive ? 'real' : 'simulation',
                initialSimulation
              )

              if (buyOperation) {
                initialSimulation.buy_operation = buyOperation
                initialSimulation.current_status = 'holding'
                initialSimulation.remaining_token_amount = buyOperation.token_amount_received
                initialSimulation.initial_token_amount = buyOperation.token_amount_received

                console.log(`💰 Buy operation completed for ${token.token_symbol}: ${buyOperation.token_amount_received} tokens (${initialSimulation.is_simulated ? 'simulated' : 'real'}) using ${assignedStrategy} strategy`)

                // Add position to SL/TP tracker for real-time monitoring
                if (!initialSimulation.is_simulated && tradingKeypair) {
                  try {
                    const strategy = getTradingStrategy(assignedStrategy)
                    await addSLTPPosition({
                      walletAddress: tradingKeypair.publicKey.toString(),
                      tokenAddress: token.token_address,
                      tokenSymbol: token.token_symbol,
                      positionSize: parseFloat(buyOperation.token_amount_received),
                      entryPrice: token.current_price,
                      stopLossPercentage: strategy.stop_loss_percentage,
                      takeProfitPercentage: strategy.take_profit_levels.tp2_percentage,
                      positionType: 'bot',
                      strategyId: assignedStrategy,
                      tp1Percentage: strategy.take_profit_levels.tp1_percentage,
                      tp1SellPercentage: strategy.take_profit_levels.tp1_sell_percentage,
                      tp2Percentage: strategy.take_profit_levels.tp2_percentage,
                      tp3Percentage: strategy.take_profit_levels.tp3_percentage,
                      tp3Enabled: strategy.take_profit_levels.tp3_enabled
                    })

                    console.log(`✅ Added ${token.token_symbol} to SL/TP tracker for real-time monitoring`)
                  } catch (slTpError) {
                    console.error('❌ Failed to add position to SL/TP tracker:', slTpError)
                  }
                }

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
        // Add validation before calling calculateGainPercentage
        if (!existingToken.initial_price_usd || existingToken.initial_price_usd <= 0) {
          console.warn(`Invalid initial price for token ${token.token_symbol}: ${existingToken.initial_price_usd}`);
          continue; // Skip this token if initial price is invalid
        }

        if (!token.current_price || token.current_price <= 0) {
          console.warn(`Invalid current price for token ${token.token_symbol}: ${token.current_price}`);
          continue; // Skip this token if current price is invalid
        }

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

        // Use priceTracking for logging/debugging (fixes unused variable warning)
        console.log(`📊 Price tracking for ${token.token_symbol}:`, {
          symbol: token.token_symbol,
          tracking: priceTracking
        });

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
          console.log(`🔍 Checking sell conditions for ${token.token_symbol} (${existingToken.trading_simulation.current_status})`)

          const sellDecision = shouldSellToken(existingToken, existingToken.trading_simulation)

          if (sellDecision.shouldSell) {
            console.log(`🚨 SELL DECISION MADE: ${sellDecision.reason}`)

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
        const existingPriceHistory: PriceRecord[] = existingToken.price_history || []
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

    // ====================================================================================================
    // PROCESS ORPHANED TOKENS (Tracked but not in current Jupiter trending list)
    // ====================================================================================================

    // Identify tokens that are being tracked but weren't in the Jupiter response
    const processedTokenAddresses = new Set(filteredTokens.map(t => t.token_address))
    const orphanedTokens = trackedTokens?.filter(t =>
      t.status === 'tracking' && !processedTokenAddresses.has(t.token_address)
    ) || []

    if (orphanedTokens.length > 0) {
      console.log(`🔍 Processing ${orphanedTokens.length} orphaned tracked tokens (not in current trending list)...`)

      // Fetch current prices for these tokens
      const tokenAddresses = orphanedTokens.map(t => t.token_address)

      // Batch fetch prices to avoid URL length limits
      const prices: Record<string, number> = {}
      const BATCH_SIZE = 50

      for (let i = 0; i < tokenAddresses.length; i += BATCH_SIZE) {
        const batch = tokenAddresses.slice(i, i + BATCH_SIZE)
        try {
          const batchPrices = await fetchTokenPricesForTracking(batch)
          Object.assign(prices, batchPrices)
        } catch (err) {
          console.error(`Error fetching prices for batch ${i}-${i + BATCH_SIZE}:`, err)
        }
      }

      // Process each orphaned token
      for (const existingToken of orphanedTokens) {
        const currentPrice = prices[existingToken.token_address]

        if (!currentPrice) {
          // If price is missing, we can't update. Log warning and skip.
          // console.warn(`⚠️ Could not fetch price for orphaned token: ${existingToken.token_symbol}`)
          continue
        }

        // Reconstruct a token object similar to what we get from Jupiter, but using existing metadata
        const token = {
          token_address: existingToken.token_address,
          token_symbol: existingToken.token_symbol || 'UNKNOWN',
          token_name: existingToken.token_name || 'Unknown Token',
          current_price: currentPrice,
          volume_1h: existingToken.volume_1h || 0, // Fallback to existing volume or 0
          market_cap: existingToken.market_cap || 0,
          organic_score: existingToken.organic_score || 0,
          volume_5m: existingToken.volume_5m || 0,
          status_changed_at: existingToken.status_changed_at || existingToken.created_at,
          created_at: existingToken.created_at
        }

        // Calculate gains
        const currentGain = calculateGainPercentage(currentPrice, existingToken.initial_price_usd)
        const newPeakPrice = Math.max(existingToken.peak_price_usd, currentPrice)
        const peakGain = newPeakPrice > existingToken.peak_price_usd ?
          calculateGainPercentage(newPeakPrice, existingToken.initial_price_usd) :
          existingToken.peak_gain_percentage

        // Check loss condition (same as main loop)
        const isLost = currentGain <= -50

        // Check if trading simulation should sell
        let shouldSell = false
        let sellOperation = null

        if (existingToken.trading_simulation && existingToken.trading_simulation.current_status === 'holding') {
          const sellDecision = shouldSellToken(existingToken, existingToken.trading_simulation)

          if (sellDecision.shouldSell) {
            console.log(`🚨 ORPHAN SELL DECISION: ${sellDecision.reason} for ${token.token_symbol}`)

            // Perform sell simulation
            const sellOp = await performSellOperation(
              { ...token, current_price: currentPrice },
              existingToken.trading_simulation,
              sellDecision.sellPercentage
            )

            if (sellOp) {
              sellOperation = sellOp
              shouldSell = true

              // Calculate final gain
              const finalGain = calculateGainPercentage(currentPrice, existingToken.initial_price_usd)
              const simulationStart = new Date(existingToken.trading_simulation.simulation_started_at)
              const now = new Date()
              const holdDurationHours = (now.getTime() - simulationStart.getTime()) / (1000 * 60 * 60)

              sellOperation.final_gain_percentage = finalGain
              sellOperation.hold_duration_hours = holdDurationHours

              existingToken.trading_simulation.sell_operations.push(sellOperation)

              const remainingTokens = parseFloat(existingToken.trading_simulation.remaining_token_amount || '0')
              const isPositionClosed = sellDecision.sellPercentage === 100 || remainingTokens < 1000

              if (isPositionClosed) {
                existingToken.trading_simulation.current_status = 'completed'
                existingToken.trading_simulation.remaining_token_amount = '0'

                // Calculate final result
                const buyOperation = existingToken.trading_simulation.buy_operation
                if (buyOperation) {
                  const totalSolReceived = existingToken.trading_simulation.sell_operations.reduce(
                    (total: number, op: any) => total + (parseFloat(op.sol_received) / 1e9), 0
                  )
                  const totalSolGain = totalSolReceived - buyOperation.buy_amount_sol

                  existingToken.trading_simulation.final_result = {
                    success: finalGain > 0,
                    total_gain_percentage: finalGain,
                    total_gain_sol: totalSolGain,
                    buy_price_usd: buyOperation.buy_price_usd,
                    sell_price_usd: currentPrice,
                    hold_duration_hours: holdDurationHours,
                    best_buy_config: buyOperation.best_buy_config,
                    best_sell_configs: existingToken.trading_simulation.sell_operations.map((op: any) => op.best_sell_config)
                  }
                }
              }

              // Log trade operation
              logTradeOperation('Sell Operation (Orphaned)', {
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
                  console.error('Failed to send Discord alert for orphaned sell:', error)
                })
              }
            }
          }
        }

        // Update price history
        const newPriceRecord: PriceRecord = {
          timestamp: new Date().toISOString(),
          price_usd: currentPrice,
          volume: token.volume_1h
        }

        const existingPriceHistory: PriceRecord[] = existingToken.price_history || []
        const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000)

        const updatedPriceHistory = [
          ...existingPriceHistory.filter((record: PriceRecord) => new Date(record.timestamp) > cutoffTime),
          newPriceRecord
        ].slice(-288)

        // Add update promise
        if (isLost && existingToken.status === 'tracking') {
          updatesPromises.push((async () => {
            await supabase.from(TRACKER_TABLE).update({
              last_price_usd: currentPrice,
              peak_price_usd: newPeakPrice,
              current_gain_percentage: currentGain,
              peak_gain_percentage: peakGain,
              status: 'lost',
              status_changed_at: new Date().toISOString(),
              trading_simulation: existingToken.trading_simulation,
              price_history: updatedPriceHistory
            }).eq('id', existingToken.id)
          })())
          tokensLost++
          console.log(`❌ Orphaned Token lost (${currentGain.toFixed(2)}%): ${token.token_symbol}`)
        } else {
          updatesPromises.push((async () => {
            await supabase.from(TRACKER_TABLE).update({
              last_price_usd: currentPrice,
              peak_price_usd: newPeakPrice,
              current_gain_percentage: currentGain,
              peak_gain_percentage: peakGain,
              trading_simulation: existingToken.trading_simulation,
              price_history: updatedPriceHistory
            }).eq('id', existingToken.id)
          })())
          tokensUpdated++
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

      // Log strategy distribution summary
      console.log('📊 Active strategy summary:')
      activeStrategies.forEach(strategyId => {
        const strategyActiveTrades = activeTradesByStrategy.get(strategyId)
        const activeCount = strategyActiveTrades ? strategyActiveTrades.size : 0
        console.log(`  ${strategyId}: ${activeCount} active trades`)
      })
    }

    // Set a timestamp for cache invalidation (could be used by other APIs)
    const headers: Record<string, string> = {
      'X-Data-Updated': new Date().toISOString(),
      'Cache-Control': 'no-cache' // Track route should never be cached
    }

    // Add strategy information to response
    const strategyInfo = activeStrategies.reduce((acc, strategyId) => {
      const strategyActiveTrades = activeTradesByStrategy.get(strategyId)
      acc[strategyId] = {
        active_trades: strategyActiveTrades ? strategyActiveTrades.size : 0,
        strategy_name: TRADING_STRATEGIES[strategyId]?.name || strategyId
      }
      return acc
    }, {} as Record<string, any>)

    return NextResponse.json({
      ...summary,
      strategy_info: strategyInfo
    }, {
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

export const POST = withUnifiedLogging(async (request: NextRequest, logger) => {
  try {
    logger.info('api_request', 'Starting trending token tracking...')

    // Run wallet diagnostics to help troubleshoot balance issues
    await diagnoseTradingWallet()

    return await internalTrackPost(request, logger)
  } catch (error) {
    logger.critical('api_request', 'Error in POST handler', error as Error)
    return NextResponse.json({
      error: 'Failed to process tracking request',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
})

export const GET = withUnifiedLogging(async (request: NextRequest, logger) => {
  try {
    const { searchParams } = new URL(request.url)
    const tokenAddress = searchParams.get('token')

    if (!tokenAddress) {
      logger.warn('api_request', 'Token address missing from request')
      return NextResponse.json({ error: 'Token address is required', example: '/api/trending/track?token=TOKEN_ADDRESS' }, { status: 400 })
    }

    logger.info('api_request', 'Fetching token tracking data', { tokenAddress })

    // Get token data with trade comparison
    const { data: token, error } = await supabase
      .from(TRACKER_TABLE)
      .select('*')
      .eq('token_address', tokenAddress)
      .single()

    if (error || !token) {
      logger.warn('api_request', 'Tracked token not found', { tokenAddress, error })
      return NextResponse.json({ error: 'Token not found', token_address: tokenAddress }, { status: 404 })
    }

    logger.info('api_request', 'Successfully retrieved tracked token', { tokenAddress, status: token.status })

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
    logger.error('api_request', 'Error retrieving token trade comparison', error as Error)
    return NextResponse.json({
      error: 'Failed to retrieve token trade comparison',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    }, { status: 500 })
  }
})

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

// Add strategy-specific active trades tracking
const activeTradesByStrategy = new Map<string, Set<string>>()

// Initialize strategy tracking
function initializeStrategyTracking(strategies: string[]) {
  strategies.forEach(strategyId => {
    if (!activeTradesByStrategy.has(strategyId)) {
      activeTradesByStrategy.set(strategyId, new Set<string>())
    }
  })
}

// Strategy assignment logic
function assignTokenToStrategy(token: any, strategies: string[], allocation: Record<string, number>): string {
  // Strategy assignment based on token characteristics
  const marketCap = token.market_cap || 0
  const organicScore = token.organic_score || 0
  const volume1h = token.volume_1h || 0

  // Rule-based assignment with fallback to allocation
  for (const strategyId of strategies) {
    const strategy = TRADING_STRATEGIES[strategyId]

    // Check if token meets strategy conditions
    if (strategy.conditions) {
      let meetsConditions = true

      if (strategy.conditions.min_market_cap && marketCap < strategy.conditions.min_market_cap) {
        meetsConditions = false
      }

      // Add check for max_market_cap if defined in conditions
      if (strategy.conditions.max_market_cap && marketCap > strategy.conditions.max_market_cap) {
        meetsConditions = false
      }

      if (strategy.conditions.min_organic_score && organicScore < strategy.conditions.min_organic_score) {
        meetsConditions = false
      }

      // Note: Risk assessment is now handled before assignment with comprehensive risk assessment

      if (meetsConditions) {
        console.log(`🎯 Token ${token.token_symbol} assigned to ${strategyId} strategy (rule-based)`)
        return strategyId
      }
    }
  }

  // Fallback to weighted random selection based on allocation
  const random = Math.random()
  let cumulativeWeight = 0

  for (const strategyId of strategies) {
    cumulativeWeight += allocation[strategyId]
    if (random <= cumulativeWeight) {
      console.log(`🎯 Token ${token.token_symbol} assigned to ${strategyId} strategy (allocation-based)`)
      return strategyId
    }
  }

  // Final fallback to first strategy
  console.log(`🎯 Token ${token.token_symbol} assigned to ${strategies[0]} strategy (fallback)`)
  return strategies[0]
}

// Enhanced duplicate prevention: track recent purchases
const recentPurchases = new Map<string, { count: number, lastPurchase: Date, purchaseDates: Date[] }>()

// Connection management for real trading
let tradingConnection: Connection | null = null
let tradingKeypair: Keypair | null = null
let tradingSigner: ((transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>) | null = null

function initializeTradingConnection(): Connection {
  if (!tradingConnection) {
    tradingConnection = createRpcConnection('confirmed')
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

// Add strategy-specific risk calculation
async function getTotalSOLAtRiskByStrategy(strategyId: string): Promise<number> {
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
  // Maintain backward compatibility - use first active strategy
  const { strategies } = getActiveStrategies()
  return canExecuteRealTradeWithStrategy(buyAmountSOL, strategies[0], tokenAddress, tokenSymbol, currentPrice)
}

// Update balance checking for multi-strategy
async function canExecuteRealTradeWithStrategy(
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
  const { allocation } = getActiveStrategies()
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