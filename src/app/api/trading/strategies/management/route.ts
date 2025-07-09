import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { TradingStrategy } from '@/types/trading-strategies'
import { getEnabledStrategies } from '@/utils/strategy-selector'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

interface StrategyPerformanceMetrics {
  strategy_id: string
  strategy_name: string
  total_tokens_tracked: number
  active_positions: number
  completed_trades: number
  win_rate: number
  average_gain_percentage: number
  average_loss_percentage: number
  total_pnl_sol: number
  total_pnl_percentage: number
  max_gain_percentage: number
  max_loss_percentage: number
  last_24h_trades: number
  last_24h_pnl: number
  current_sol_at_risk: number
  strategy_distribution_percentage: number
}

interface StrategyManagementData {
  strategies: TradingStrategy[]
  performance_metrics: StrategyPerformanceMetrics[]
  overall_stats: {
    total_active_strategies: number
    total_active_positions: number
    total_sol_at_risk: number
    overall_win_rate: number
    overall_pnl_24h: number
    strategy_distribution: { [strategy_id: string]: number }
  }
  recent_trades: Array<{
    token_symbol: string
    token_address: string
    strategy_id: string
    strategy_name: string
    trade_type: 'buy' | 'sell'
    price: number
    amount_sol: number
    gain_percentage?: number
    timestamp: string
    is_simulated: boolean
  }>
}

// GET /api/trading/strategies/management - Get comprehensive strategy management data
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const timeframe = searchParams.get('timeframe') || '24h' // 24h, 7d, 30d
    const includeSimulated = searchParams.get('include_simulated') !== 'false'
    
    // Get all strategies
    const strategies = await getEnabledStrategies()
    
    // Calculate timeframe filter
    const now = new Date()
    let timeFilter: string
    switch (timeframe) {
      case '7d':
        timeFilter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
        break
      case '30d':
        timeFilter = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
        break
      default: // 24h
        timeFilter = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
    }
    
    // Get tracked tokens with strategy information
    const { data: trackedTokens, error: tokensError } = await supabase
      .from('tracked_tokens')
      .select('*')
      .not('strategy_id', 'is', null)
      .gte('tracking_started_at', timeFilter)
    
    if (tokensError) {
      console.error('Error fetching tracked tokens:', tokensError)
      throw tokensError
    }
    
    // Calculate performance metrics for each strategy
    const performanceMetrics: StrategyPerformanceMetrics[] = []
    const strategyDistribution: { [strategy_id: string]: number } = {}
    let totalActivePositions = 0
    let totalSolAtRisk = 0
    let overallPnl24h = 0
    let totalCompletedTrades = 0
    let totalWinningTrades = 0
    
    for (const strategy of strategies) {
      const strategyTokens = trackedTokens?.filter(t => t.strategy_id === strategy.id) || []
      
      // Filter by simulation preference
      const filteredTokens = includeSimulated ? strategyTokens : 
        strategyTokens.filter(t => t.trading_simulation && !t.trading_simulation.is_simulated)
      
      const activePositions = filteredTokens.filter(t => t.status === 'tracking').length
      const completedTrades = filteredTokens.filter(t => 
        t.status === 'won' || t.status === 'lost' || t.status === 'sold'
      ).length
      
      // Calculate win rate
      const winningTrades = filteredTokens.filter(t => t.status === 'won').length
      const winRate = completedTrades > 0 ? (winningTrades / completedTrades) * 100 : 0
      
      // Calculate PnL metrics
      let totalPnlSol = 0
      let totalPnlPercentage = 0
      let maxGain = 0
      let maxLoss = 0
      let averageGain = 0
      let averageLoss = 0
      let solAtRisk = 0
      
      const gains: number[] = []
      const losses: number[] = []
      
      for (const token of filteredTokens) {
        if (token.trading_simulation?.final_result) {
          const result = token.trading_simulation.final_result
          totalPnlSol += result.total_pnl_sol || 0
          totalPnlPercentage += result.total_pnl_percentage || 0
          
          const gainPercentage = result.total_pnl_percentage || 0
          if (gainPercentage > 0) {
            gains.push(gainPercentage)
            maxGain = Math.max(maxGain, gainPercentage)
          } else if (gainPercentage < 0) {
            losses.push(Math.abs(gainPercentage))
            maxLoss = Math.max(maxLoss, Math.abs(gainPercentage))
          }
        }
        
        // Calculate SOL at risk for active positions
        if (token.status === 'tracking' && token.trading_simulation?.buy_operation) {
          solAtRisk += parseFloat(token.trading_simulation.buy_operation.sol_amount || '0')
        }
      }
      
      averageGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / gains.length : 0
      averageLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0
      
      // Calculate 24h metrics
      const last24hTokens = filteredTokens.filter(t => 
        new Date(t.tracking_started_at).getTime() > now.getTime() - 24 * 60 * 60 * 1000
      )
      const last24hTrades = last24hTokens.length
      const last24hPnl = last24hTokens.reduce((sum, t) => 
        sum + (t.trading_simulation?.final_result?.total_pnl_sol || 0), 0
      )
      
      performanceMetrics.push({
        strategy_id: strategy.id,
        strategy_name: strategy.name,
        total_tokens_tracked: filteredTokens.length,
        active_positions: activePositions,
        completed_trades: completedTrades,
        win_rate: winRate,
        average_gain_percentage: averageGain,
        average_loss_percentage: averageLoss,
        total_pnl_sol: totalPnlSol,
        total_pnl_percentage: totalPnlPercentage,
        max_gain_percentage: maxGain,
        max_loss_percentage: maxLoss,
        last_24h_trades: last24hTrades,
        last_24h_pnl: last24hPnl,
        current_sol_at_risk: solAtRisk,
        strategy_distribution_percentage: 0 // Will be calculated below
      })
      
      // Update totals
      strategyDistribution[strategy.id] = filteredTokens.length
      totalActivePositions += activePositions
      totalSolAtRisk += solAtRisk
      overallPnl24h += last24hPnl
      totalCompletedTrades += completedTrades
      totalWinningTrades += winningTrades
    }
    
    // Calculate strategy distribution percentages
    const totalTokens = Object.values(strategyDistribution).reduce((a, b) => a + b, 0)
    for (const metric of performanceMetrics) {
      metric.strategy_distribution_percentage = totalTokens > 0 ? 
        (strategyDistribution[metric.strategy_id] / totalTokens) * 100 : 0
    }
    
    // Get recent trades for activity feed
    const { data: recentTradesData, error: tradesError } = await supabase
      .from('tracked_tokens')
      .select('token_symbol, token_address, strategy_id, trading_simulation, tracking_started_at, status')
      .not('strategy_id', 'is', null)
      .not('trading_simulation', 'is', null)
      .gte('tracking_started_at', timeFilter)
      .order('tracking_started_at', { ascending: false })
      .limit(50)
    
    if (tradesError) {
      console.error('Error fetching recent trades:', tradesError)
      throw tradesError
    }
    
    // Process recent trades
    const recentTrades = []
    for (const token of recentTradesData || []) {
      const simulation = token.trading_simulation
      if (!simulation) continue
      
      // Add buy operation
      if (simulation.buy_operation) {
        const strategy = strategies.find(s => s.id === token.strategy_id)
        recentTrades.push({
          token_symbol: token.token_symbol,
          token_address: token.token_address,
          strategy_id: token.strategy_id,
          strategy_name: strategy?.name || 'Unknown',
          trade_type: 'buy' as const,
          price: parseFloat(simulation.buy_operation.token_price || '0'),
          amount_sol: parseFloat(simulation.buy_operation.sol_amount || '0'),
          timestamp: simulation.buy_operation.timestamp,
          is_simulated: simulation.is_simulated
        })
      }
      
      // Add sell operations
      for (const sellOp of simulation.sell_operations || []) {
        const strategy = strategies.find(s => s.id === token.strategy_id)
        recentTrades.push({
          token_symbol: token.token_symbol,
          token_address: token.token_address,
          strategy_id: token.strategy_id,
          strategy_name: strategy?.name || 'Unknown',
          trade_type: 'sell' as const,
          price: parseFloat(sellOp.token_price || '0'),
          amount_sol: parseFloat(sellOp.sol_received || '0'),
          gain_percentage: sellOp.gain_percentage,
          timestamp: sellOp.timestamp,
          is_simulated: simulation.is_simulated
        })
      }
    }
    
    // Sort recent trades by timestamp
    recentTrades.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    
    const overallWinRate = totalCompletedTrades > 0 ? (totalWinningTrades / totalCompletedTrades) * 100 : 0
    
    const managementData: StrategyManagementData = {
      strategies,
      performance_metrics: performanceMetrics,
      overall_stats: {
        total_active_strategies: strategies.length,
        total_active_positions: totalActivePositions,
        total_sol_at_risk: totalSolAtRisk,
        overall_win_rate: overallWinRate,
        overall_pnl_24h: overallPnl24h,
        strategy_distribution: strategyDistribution
      },
      recent_trades: recentTrades.slice(0, 20) // Limit to 20 most recent
    }
    
    return NextResponse.json(managementData)
    
  } catch (error) {
    console.error('Strategy management error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch strategy management data' },
      { status: 500 }
    )
  }
}

// POST /api/trading/strategies/management - Bulk strategy operations
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action, strategy_ids, config } = body
    
    switch (action) {
      case 'enable_strategies':
        if (!Array.isArray(strategy_ids)) {
          return NextResponse.json({ error: 'strategy_ids must be an array' }, { status: 400 })
        }
        
        const { error: enableError } = await supabase
          .from('trading_strategies')
          .update({ enabled: true, updated_at: new Date().toISOString() })
          .in('id', strategy_ids)
        
        if (enableError) throw enableError
        
        return NextResponse.json({ 
          message: `Enabled ${strategy_ids.length} strategies`,
          strategy_ids 
        })
        
      case 'disable_strategies':
        if (!Array.isArray(strategy_ids)) {
          return NextResponse.json({ error: 'strategy_ids must be an array' }, { status: 400 })
        }
        
        const { error: disableError } = await supabase
          .from('trading_strategies')
          .update({ enabled: false, updated_at: new Date().toISOString() })
          .in('id', strategy_ids)
        
        if (disableError) throw disableError
        
        return NextResponse.json({ 
          message: `Disabled ${strategy_ids.length} strategies`,
          strategy_ids 
        })
        
      case 'update_risk_limits':
        if (!config || typeof config !== 'object') {
          return NextResponse.json({ error: 'config object is required' }, { status: 400 })
        }
        
        // Update risk management settings for specified strategies
        const updates = []
        for (const strategyId of strategy_ids || []) {
          const { data: strategy } = await supabase
            .from('trading_strategies')
            .select('risk_management')
            .eq('id', strategyId)
            .single()
          
          if (strategy) {
            const updatedRiskManagement = {
              ...strategy.risk_management,
              ...config
            }
            
            updates.push(
              supabase
                .from('trading_strategies')
                .update({ 
                  risk_management: updatedRiskManagement,
                  updated_at: new Date().toISOString()
                })
                .eq('id', strategyId)
            )
          }
        }
        
        await Promise.all(updates)
        
        return NextResponse.json({ 
          message: `Updated risk limits for ${strategy_ids?.length || 0} strategies`,
          config 
        })
        
      case 'reset_performance':
        if (!Array.isArray(strategy_ids)) {
          return NextResponse.json({ error: 'strategy_ids must be an array' }, { status: 400 })
        }
        
        // Reset performance metrics for specified strategies
        const resetPerformance = {
          total_trades: 0,
          winning_trades: 0,
          losing_trades: 0,
          win_rate: 0,
          total_pnl_sol: 0,
          total_pnl_percentage: 0,
          average_gain_percentage: 0,
          average_loss_percentage: 0,
          max_gain_percentage: 0,
          max_loss_percentage: 0,
          max_drawdown_percentage: 0,
          daily_pnl: {},
          hourly_performance: {},
          last_updated: new Date().toISOString()
        }
        
        const { error: resetError } = await supabase
          .from('trading_strategies')
          .update({ 
            performance: resetPerformance,
            updated_at: new Date().toISOString()
          })
          .in('id', strategy_ids)
        
        if (resetError) throw resetError
        
        return NextResponse.json({ 
          message: `Reset performance metrics for ${strategy_ids.length} strategies`,
          strategy_ids 
        })
        
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }
    
  } catch (error) {
    console.error('Strategy management operation error:', error)
    return NextResponse.json(
      { error: 'Failed to perform strategy management operation' },
      { status: 500 }
    )
  }
}