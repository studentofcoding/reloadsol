import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'
import { supabase } from '@/utils/supabase'
import { compareTradeQuotes, performEnhancedTradeComparison } from '@/utils/trade-comparison'

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
    slippage_5: BuyConfigResult
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
    slippage_5: SellConfigResult
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

interface TradingSimulation {
  token_address: string
  token_symbol: string | null
  simulation_started_at: string
  buy_operation: BuyOperation | null
  sell_operations: SellOperation[]
  current_status: 'buying' | 'holding' | 'selling' | 'completed' | 'failed'
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

// ===== Discord Trade Alert Helper =====
const DISCORD_WEBHOOK_URL =
  process.env.NODE_ENV === 'development'
    ? process.env.DISCORD_WEBHOOK_AUTO_TRADE_DEV || process.env.DISCORD_WEBHOOK_AUTO_TRADE
    : process.env.DISCORD_WEBHOOK_AUTO_TRADE
const ENABLE_DISCORD_NOTIFICATIONS = process.env.ENABLE_DISCORD_NOTIFICATIONS === 'true'

async function sendTradeAlertDiscord(params: {
  tokenSymbol: string | null
  status: 'buy' | 'partial-sell' | 'completed'
  isSimulated: boolean
  currentGain: number
  peakGain: number
  priceUsd: number
  provider?: string
  rpcUsed?: string
  responseTime?: number
}) {
  try {
    if (!ENABLE_DISCORD_NOTIFICATIONS || !DISCORD_WEBHOOK_URL) return

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

    const title = `🔔 Trade Alert (${isSimulated ? 'Simulation' : 'LIVE'})`

    const lines = [
      `${status} triggered for ${tokenSymbol ?? 'UNKNOWN'}`,
      `Current Gain: ${currentGain.toFixed(4)}%`,
      `Peak Gain: ${peakGain.toFixed(4)}%`,
      `Price: ${priceUsd.toFixed(6)}`
    ]

    if (provider) lines.push(`Provider: ${provider}`)
    if (rpcUsed) lines.push(`RPC: ${rpcUsed}`)
    if (responseTime !== undefined) lines.push(`Response Time: ${responseTime}ms`)
    lines.push(`Time: ${new Date().toLocaleString()}`)

    const content = [title, ...lines].join('\n')

    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    })
  } catch (err) {
    console.error('Failed to send Discord trade alert:', err)
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
      0.1 // 0.1 SOL
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
      .select('*')
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

// Helper function to perform buy simulation
async function performBuySimulation(token: any): Promise<BuyOperation | null> {
  try {
    console.log(`💰 Performing buy simulation for ${token.token_symbol} (${token.token_address})`)
    
    // SOL mint address
    const SOL_MINT = 'So11111111111111111111111111111111111111112'
    const BUY_AMOUNT_SOL = 0.1 // 0.1 SOL
    const BUY_AMOUNT_LAMPORTS = Math.floor(BUY_AMOUNT_SOL * 1e9)
    
    // Test different RPCs and configurations
    const rpcConfigs = [
      { name: 'Helius', url: 'https://mainnet.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b' },
      { name: 'Shyft', url: 'https://rpc.shyft.to?api_key=dt_BAV8lwogCz_vn' },
    ]
    
    const slippageConfigs = [
      { key: 'slippage_1', bps: 100 },
      { key: 'slippage_2', bps: 200 },
      { key: 'slippage_5', bps: 500 }
    ]
    
    const configurations: any = {}
    const allResults: any[] = []
    
    // Test each slippage configuration
    for (const config of slippageConfigs) {
      const rpcResults: any[] = []
      
      // Test with different RPCs in parallel
      const rpcPromises = rpcConfigs.map(async (rpc) => {
        try {
          console.log(`  📊 Testing ${config.key} with ${rpc.name}...`)
          
          const comparison = await compareTradeQuotes({
            inputMint: SOL_MINT,
            outputMint: token.token_address,
            amount: BUY_AMOUNT_LAMPORTS.toString(),
            slippageBps: config.bps,
            userPublicKey: '11111111111111111111111111111111'
          })
          
          if (comparison.bestQuote && comparison.bestQuote.success) {
            const bestQuote = comparison.bestQuote
            const totalFees = bestQuote.fees?.totalFeeLamports || 0
            
            const result = {
              rpc: rpc.name,
              success: true,
              response_time: bestQuote.responseTime,
              token_amount: bestQuote.outAmount,
              total_fees: totalFees / 1e9,
              price_impact: bestQuote.priceImpactPct,
              best_provider: bestQuote.provider
            }
            
            rpcResults.push(result)
            allResults.push({ ...result, slippage: config.bps / 100 })
            
            console.log(`    ✅ ${rpc.name}: ${bestQuote.provider} - ${bestQuote.outAmount} tokens, ${bestQuote.responseTime}ms`)
            return result
          } else {
            console.log(`    ❌ ${rpc.name}: No successful quotes`)
            return null
          }
        } catch (error) {
          console.error(`    ❌ ${rpc.name} error:`, error)
          return null
        }
      })
      
      // Wait for all RPC tests to complete
      const rpcResultsCompleted = await Promise.allSettled(rpcPromises)
      const successfulResults = rpcResultsCompleted
        .filter(result => result.status === 'fulfilled' && result.value)
        .map(result => (result as PromiseFulfilledResult<any>).value)
      
      if (successfulResults.length > 0) {
        // Find best result for this slippage configuration
        const bestResult = successfulResults.reduce((best, current) => {
          const bestAmount = parseFloat(best.token_amount)
          const currentAmount = parseFloat(current.token_amount)
          return currentAmount > bestAmount ? current : best
        })
        
        configurations[config.key] = {
          success: true,
          response_time: bestResult.response_time,
          token_amount: bestResult.token_amount,
          total_fees: bestResult.total_fees,
          price_impact: bestResult.price_impact,
          best_provider: bestResult.best_provider,
          rpc_used: bestResult.rpc
        }
      } else {
        configurations[config.key] = {
          success: false,
          response_time: 0,
          token_amount: '0',
          total_fees: 0,
          price_impact: '0',
          best_provider: 'none',
          error: 'No successful quotes across all RPCs'
        }
      }
      
      // Small delay between configurations
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    
    // Determine overall best configuration
    let bestBuyConfig = null
    if (allResults.length > 0) {
      const bestResult = allResults.reduce((best, current) => {
        const bestAmount = parseFloat(best.token_amount)
        const currentAmount = parseFloat(current.token_amount)
        return currentAmount > bestAmount ? current : best
      })
      
      bestBuyConfig = {
        slippage: bestResult.slippage,
        provider: bestResult.best_provider,
        token_amount: bestResult.token_amount,
        response_time: bestResult.response_time,
        total_fees: bestResult.total_fees,
        rpc_used: bestResult.rpc
      }
    }
    
    if (!bestBuyConfig) {
      console.log(`❌ No successful buy configurations for ${token.token_symbol}`)
      return null
    }
    
    const buyOperation: BuyOperation = {
      timestamp: new Date().toISOString(),
      buy_amount_sol: BUY_AMOUNT_SOL,
      token_amount_received: bestBuyConfig.token_amount,
      buy_price_usd: token.current_price,
      configurations,
      best_buy_config: bestBuyConfig,
      rpc_used: bestBuyConfig.rpc_used
    }
    
    console.log(`✅ Buy simulation completed for ${token.token_symbol}: ${bestBuyConfig.token_amount} tokens via ${bestBuyConfig.provider}`)
    return buyOperation
    
  } catch (error) {
    console.error(`❌ Error performing buy simulation for ${token.token_symbol}:`, error)
    return null
  }
}

// Helper function to perform sell simulation
async function performSellSimulation(
  token: any, 
  simulation: TradingSimulation,
  sellPercentage: number
): Promise<SellOperation | null> {
  try {
    console.log(`💸 Performing ${sellPercentage}% sell simulation for ${token.token_symbol} (${token.token_address})`)
    
    // SOL mint address
    const SOL_MINT = 'So11111111111111111111111111111111111111112'
    
    // Calculate token amount to sell based on percentage
    const totalTokenAmount = simulation.remaining_token_amount || simulation.buy_operation?.token_amount_received || '0'
    const tokenAmountToSell = (parseFloat(totalTokenAmount) * (sellPercentage / 100)).toString()
    
    // Test different RPCs and configurations
    const rpcConfigs = [
      { name: 'Helius', url: 'https://mainnet.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b' },
      { name: 'Shyft', url: 'https://rpc.shyft.to?api_key=dt_BAV8lwogCz_vn' },
    ]
    
    const slippageConfigs = [
      { key: 'slippage_1', bps: 100 },
      { key: 'slippage_2', bps: 200 },
      { key: 'slippage_5', bps: 500 }
    ]
    
    const configurations: any = {}
    const allResults: any[] = []
    
    // Test each slippage configuration
    for (const config of slippageConfigs) {
      const rpcResults: any[] = []
      
      // Test with different RPCs in parallel
      const rpcPromises = rpcConfigs.map(async (rpc) => {
        try {
          console.log(`  📊 Testing sell ${config.key} with ${rpc.name}...`)
          
          const comparison = await compareTradeQuotes({
            inputMint: token.token_address,
            outputMint: SOL_MINT,
            amount: tokenAmountToSell,
            slippageBps: config.bps,
            userPublicKey: simulation.is_simulated ? '11111111111111111111111111111111' : simulation.keypair_path || '11111111111111111111111111111111'
          })
          
          if (comparison.bestQuote && comparison.bestQuote.success) {
            const bestQuote = comparison.bestQuote
            const totalFees = bestQuote.fees?.totalFeeLamports || 0
            
            const result = {
              rpc: rpc.name,
              success: true,
              response_time: bestQuote.responseTime,
              sol_amount: bestQuote.outAmount,
              total_fees: totalFees / 1e9,
              price_impact: bestQuote.priceImpactPct,
              best_provider: bestQuote.provider
            }
            
            rpcResults.push(result)
            allResults.push({ ...result, slippage: config.bps / 100 })
            
            console.log(`    ✅ ${rpc.name}: ${bestQuote.provider} - ${bestQuote.outAmount} SOL, ${bestQuote.responseTime}ms`)
            return result
          } else {
            console.log(`    ❌ ${rpc.name}: No successful quotes`)
            return null
          }
        } catch (error) {
          console.error(`    ❌ ${rpc.name} error:`, error)
          return null
        }
      })
      
      // Wait for all RPC tests to complete
      const rpcResultsCompleted = await Promise.allSettled(rpcPromises)
      const successfulResults = rpcResultsCompleted
        .filter(result => result.status === 'fulfilled' && result.value)
        .map(result => (result as PromiseFulfilledResult<any>).value)
      
      if (successfulResults.length > 0) {
        // Find best result for this slippage configuration
        const bestResult = successfulResults.reduce((best, current) => {
          const bestAmount = parseFloat(best.sol_amount)
          const currentAmount = parseFloat(current.sol_amount)
          return currentAmount > bestAmount ? current : best
        })
        
        configurations[config.key] = {
          success: true,
          response_time: bestResult.response_time,
          sol_amount: bestResult.sol_amount,
          total_fees: bestResult.total_fees,
          price_impact: bestResult.price_impact,
          best_provider: bestResult.best_provider,
          rpc_used: bestResult.rpc
        }
      } else {
        configurations[config.key] = {
          success: false,
          response_time: 0,
          sol_amount: '0',
          total_fees: 0,
          price_impact: '0',
          best_provider: 'none',
          error: 'No successful quotes across all RPCs'
        }
      }
      
      // Small delay between configurations
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    
    // Determine overall best configuration
    let bestSellConfig = null
    if (allResults.length > 0) {
      const bestResult = allResults.reduce((best, current) => {
        const bestAmount = parseFloat(best.sol_amount)
        const currentAmount = parseFloat(current.sol_amount)
        return currentAmount > bestAmount ? current : best
      })
      
      bestSellConfig = {
        slippage: bestResult.slippage,
        provider: bestResult.best_provider,
        sol_amount: bestResult.sol_amount,
        response_time: bestResult.response_time,
        total_fees: bestResult.total_fees,
        rpc_used: bestResult.rpc
      }
    }
    
    if (!bestSellConfig) {
      console.log(`❌ No successful sell configurations for ${token.token_symbol}`)
      return null
    }
    
    // Calculate remaining token amount after this sell
    const remainingTokens = (parseFloat(totalTokenAmount) * (1 - sellPercentage / 100)).toString()
    
    const sellOperation: SellOperation = {
      timestamp: new Date().toISOString(),
      sell_amount_tokens: tokenAmountToSell,
      sol_received: bestSellConfig.sol_amount,
      sell_price_usd: token.current_price,
      configurations,
      best_sell_config: bestSellConfig,
      rpc_used: bestSellConfig.rpc_used,
      final_gain_percentage: token.current_gain_percentage,
      hold_duration_hours: (new Date().getTime() - new Date(simulation.simulation_started_at).getTime()) / (1000 * 60 * 60)
    }
    
    // Update simulation's remaining token amount
    simulation.remaining_token_amount = remainingTokens
    
    console.log(`✅ ${sellPercentage}% sell simulation completed for ${token.token_symbol}: ${bestSellConfig.sol_amount} SOL received, ${remainingTokens} tokens remaining`)
    return sellOperation
    
  } catch (error) {
    console.error(`❌ Error performing sell simulation for ${token.token_symbol}:`, error)
    return null
  }
}

// Helper function to check if token should be sold
function shouldSellToken(token: TrackedToken, simulation: TradingSimulation): { shouldSell: boolean, sellPercentage: number, reason: string } {
  const currentGain = token.current_gain_percentage
  const peakGain = token.peak_gain_percentage
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
      .from('trending_token_tracker')
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
          .from('trending_token_tracker')
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

    if (!isSimulated && !keypairPath) {
      return NextResponse.json({ error: 'keypairPath is required for real trading' }, { status: 400 })
    }

    await setTradingMode(isSimulated, keypairPath)

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
  try {
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
      .from('trending_token_tracker')
      .select('*')
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
    const updatesPromises: Promise<any>[] = []

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
        
        // Perform buy simulation for new tokens
        let tradingSimulation: TradingSimulation | null = null
        try {
          const buyOperation = await performBuySimulation(token)
          
          if (buyOperation) {
            tradingSimulation = {
              token_address: token.token_address,
              token_symbol: token.token_symbol,
              simulation_started_at: new Date().toISOString(),
              buy_operation: buyOperation,
              sell_operations: [],
              current_status: 'holding',
              remaining_token_amount: buyOperation.token_amount_received,
              initial_token_amount: buyOperation.token_amount_received,
              is_simulated: true,
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
            
            console.log(`💰 Buy simulation completed for ${token.token_symbol}: ${buyOperation.token_amount_received} tokens`)
          } else {
            console.log(`❌ Buy simulation failed for ${token.token_symbol}`)
          }
        } catch (error) {
          console.error(`❌ Buy simulation error for ${token.token_symbol}:`, error)
        }
        
        updatesPromises.push(
          (async () => {
            const { error } = await supabase
              .from('trending_token_tracker')
              .insert({
                id: tokenId,
                token_address: token.token_address,
                token_symbol: token.token_symbol,
                token_name: token.token_name,
                logo_url: token.logo_url,
                initial_price_usd: token.current_price,
                last_price_usd: token.current_price,
                peak_price_usd: token.current_price,
                current_gain_percentage: 0,
                peak_gain_percentage: 0,
                status: 'tracking',
                organic_score: token.organic_score,
                market_cap: token.market_cap,
                volume_1h: token.volume_1h,
                tracking_started_at: new Date().toISOString(),
                trade_comparison_data: tradeComparisonData,
                trading_simulation: tradingSimulation
              })
            if (error) throw error
          })()
        )
        
        newTokensAdded++
        console.log(`✅ Adding new token to track: ${token.token_symbol} (${token.token_address})`)
      } else {
        // Existing token - update price and check for sell conditions
        const currentGain = ((token.current_price - existingToken.initial_price_usd) / existingToken.initial_price_usd) * 100
        const newPeakPrice = Math.max(existingToken.peak_price_usd, token.current_price)
        const peakGain = ((newPeakPrice - existingToken.initial_price_usd) / existingToken.initial_price_usd) * 100
        
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
            const sellOperation = await performSellSimulation(
              {
                ...token,
                current_price: token.current_price
              }, 
              existingToken.trading_simulation,
              sellDecision.sellPercentage
            )
            
            if (sellOperation) {
              // Calculate total gain in SOL
              const totalGainSol = parseFloat(sellOperation.sol_received) - 
                (existingToken.trading_simulation.buy_operation?.buy_amount_sol || 0)
              
              // Create final result
              const finalResult = {
                success: true,
                total_gain_percentage: sellOperation.final_gain_percentage,
                total_gain_sol: totalGainSol,
                buy_price_usd: existingToken.trading_simulation.buy_operation!.buy_price_usd,
                sell_price_usd: sellOperation.sell_price_usd,
                hold_duration_hours: sellOperation.hold_duration_hours,
                best_buy_config: existingToken.trading_simulation.buy_operation!.best_buy_config,
                best_sell_configs: [...(existingToken.trading_simulation.final_result?.best_sell_configs || []), sellOperation.best_sell_config]
              }
              
              console.log(`✅ Sell simulation completed for ${token.token_symbol}: ${sellOperation.final_gain_percentage.toFixed(2)}% gain (${totalGainSol.toFixed(6)} SOL)`)
              
              // Update simulation status
              existingToken.trading_simulation.sell_operations.push(sellOperation)
              
              // Enable TP3 if this was TP1
              if (sellOperation.final_gain_percentage >= existingToken.trading_simulation.take_profit_levels.tp1_percentage) {
                existingToken.trading_simulation.take_profit_levels.tp3_enabled = true
              }
              
              // Update simulation status based on remaining tokens
              if (parseFloat(existingToken.trading_simulation.remaining_token_amount) <= 0) {
                existingToken.trading_simulation.current_status = 'completed'
                existingToken.trading_simulation.final_result = finalResult
              }
              
              // Update token status
              existingToken.status = 'won'
              existingToken.status_changed_at = new Date().toISOString()
            }
          }
        }
        
        if (isLost && existingToken.status === 'tracking') {
          // Mark as lost (original logic)
          updatesPromises.push(
            (async () => {
              const { error } = await supabase
                .from('trending_token_tracker')
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
                  trading_simulation: existingToken.trading_simulation
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
                .from('trending_token_tracker')
                .update({
                  last_price_usd: token.current_price,
                  peak_price_usd: newPeakPrice,
                  current_gain_percentage: currentGain,
                  peak_gain_percentage: peakGain,
                  organic_score: token.organic_score,
                  market_cap: token.market_cap,
                  volume_1h: token.volume_1h,
                  trading_simulation: existingToken.trading_simulation
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

        // After updating simulation and before DB update
        if (ENABLE_DISCORD_NOTIFICATIONS && sellOperation) {
          const bestCfg: any = (sellOperation as any).best_sell_config || {}
          await sendTradeAlertDiscord({
            tokenSymbol: token.token_symbol,
            status: existingToken.trading_simulation!.current_status === 'completed' ? 'completed' : 'partial-sell',
            isSimulated: existingToken.trading_simulation!.is_simulated,
            currentGain: existingToken.current_gain_percentage,
            peakGain: existingToken.peak_gain_percentage,
            priceUsd: token.current_price,
            provider: bestCfg.provider,
            rpcUsed: bestCfg.rpc_used,
            responseTime: bestCfg.response_time
          })
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
      .from('trending_token_tracker')
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

    console.log('✅ 5-minute tracking completed:', summary)
    
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
    console.error('❌ Error in trending token tracking:', error)
    return NextResponse.json({
      error: 'Failed to track trending tokens',
      message: error instanceof Error ? error.message : 'Unknown error',
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
      .from('trending_token_tracker')
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
          .from('trending_token_tracker')
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
        trading_simulation: token.trading_simulation
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