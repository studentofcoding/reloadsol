import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'
import { supabase } from '@/utils/supabase'
import {
  StrategyComparison,
  StrategyPerformance,
  BacktestResult
} from '@/types/trading-strategies'

export const runtime = 'edge'

// Table names
const STRATEGIES_TABLE = process.env.NODE_ENV === 'development' ? 'trading_strategies_dev' : 'trading_strategies'
const STRATEGY_EXECUTIONS_TABLE = process.env.NODE_ENV === 'development' ? 'strategy_executions_dev' : 'strategy_executions'

// POST - Compare multiple strategies
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { strategy_ids, start_date, end_date, comparison_type = 'performance' } = body
    
    if (!strategy_ids || !Array.isArray(strategy_ids) || strategy_ids.length < 2) {
      return NextResponse.json(
        { error: 'At least 2 strategy IDs are required for comparison' },
        { status: 400 }
      )
    }
    
    if (strategy_ids.length > 10) {
      return NextResponse.json(
        { error: 'Maximum 10 strategies can be compared at once' },
        { status: 400 }
      )
    }
    
    // Validate date range
    const startDate = start_date ? new Date(start_date) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Default: 30 days ago
    const endDate = end_date ? new Date(end_date) : new Date() // Default: now
    
    if (startDate >= endDate) {
      return NextResponse.json(
        { error: 'Start date must be before end date' },
        { status: 400 }
      )
    }
    
    // Get strategy details
    const { data: strategies, error: strategiesError } = await supabase
      .from(STRATEGIES_TABLE)
      .select('id, name, description, config, created_at')
      .in('id', strategy_ids)
    
    if (strategiesError) {
      throw new Error(`Failed to fetch strategies: ${strategiesError.message}`)
    }
    
    if (!strategies || strategies.length !== strategy_ids.length) {
      return NextResponse.json(
        { error: 'One or more strategies not found' },
        { status: 404 }
      )
    }
    
    // Get executions for all strategies in the date range
    const { data: executions, error: executionsError } = await supabase
      .from(STRATEGY_EXECUTIONS_TABLE)
      .select('*')
      .in('strategy_id', strategy_ids)
      .gte('entry_time', startDate.toISOString())
      .lte('entry_time', endDate.toISOString())
      .in('status', ['completed', 'failed'])
    
    if (executionsError) {
      throw new Error(`Failed to fetch executions: ${executionsError.message}`)
    }
    
    // Calculate performance metrics for each strategy
    const metrics: { [strategy_id: string]: StrategyPerformance } = {}
    let bestStrategy = { id: '', score: -Infinity }
    
    for (const strategy of strategies) {
      const strategyExecutions = executions?.filter(e => e.strategy_id === strategy.id) || []
      const performance = calculateStrategyPerformance(strategyExecutions, startDate, endDate)
      metrics[strategy.id] = performance
      
      // Calculate composite score for ranking
      const score = calculateCompositeScore(performance)
      if (score > bestStrategy.score) {
        bestStrategy = { id: strategy.id, score }
      }
    }
    
    // Generate comparison insights
    const insights = generateComparisonInsights(strategies, metrics)
    
    const comparison: StrategyComparison = {
      strategies: strategy_ids,
      comparison_period: {
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString()
      },
      metrics,
      winner: bestStrategy.id,
      recommendation: insights.recommendation
    }
    
    return NextResponse.json({
      success: true,
      comparison,
      insights,
      strategy_details: strategies.reduce((acc, s) => {
        acc[s.id] = s
        return acc
      }, {} as Record<string, any>)
    })
    
  } catch (error) {
    console.error('❌ Error comparing strategies:', error)
    return NextResponse.json(
      { error: 'Failed to compare strategies', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// GET - Get historical comparison data
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const strategyIds = searchParams.get('strategy_ids')?.split(',')
    const period = searchParams.get('period') || '30d' // 7d, 30d, 90d, 1y
    const metric = searchParams.get('metric') || 'total_pnl_sol'
    
    if (!strategyIds || strategyIds.length === 0) {
      return NextResponse.json(
        { error: 'Missing required parameter: strategy_ids' },
        { status: 400 }
      )
    }
    
    // Calculate date range based on period
    const endDate = new Date()
    const startDate = new Date()
    
    switch (period) {
      case '7d':
        startDate.setDate(endDate.getDate() - 7)
        break
      case '30d':
        startDate.setDate(endDate.getDate() - 30)
        break
      case '90d':
        startDate.setDate(endDate.getDate() - 90)
        break
      case '1y':
        startDate.setFullYear(endDate.getFullYear() - 1)
        break
      default:
        startDate.setDate(endDate.getDate() - 30)
    }
    
    // Get daily performance data
    const { data: executions, error } = await supabase
      .from(STRATEGY_EXECUTIONS_TABLE)
      .select('strategy_id, exit_time, final_pnl_sol, final_pnl_percentage')
      .in('strategy_id', strategyIds)
      .gte('exit_time', startDate.toISOString())
      .lte('exit_time', endDate.toISOString())
      .eq('status', 'completed')
      .not('exit_time', 'is', null)
      .order('exit_time')
    
    if (error) {
      throw new Error(`Failed to fetch historical data: ${error.message}`)
    }
    
    // Group by strategy and date
    const dailyData: Record<string, Record<string, number>> = {}
    
    strategyIds.forEach(strategyId => {
      dailyData[strategyId] = {}
      
      // Initialize all dates with 0
      const currentDate = new Date(startDate)
      while (currentDate <= endDate) {
        const dateStr = currentDate.toISOString().split('T')[0]
        dailyData[strategyId][dateStr] = 0
        currentDate.setDate(currentDate.getDate() + 1)
      }
    })
    
    // Aggregate executions by date
    executions?.forEach(execution => {
      if (execution.exit_time) {
        const date = new Date(execution.exit_time).toISOString().split('T')[0]
        const value = metric === 'total_pnl_percentage' ? execution.final_pnl_percentage : execution.final_pnl_sol
        
        if (dailyData[execution.strategy_id] && dailyData[execution.strategy_id][date] !== undefined) {
          dailyData[execution.strategy_id][date] += value || 0
        }
      }
    })
    
    // Convert to cumulative if requested
    const cumulative = searchParams.get('cumulative') === 'true'
    if (cumulative) {
      strategyIds.forEach(strategyId => {
        let runningTotal = 0
        const dates = Object.keys(dailyData[strategyId]).sort()
        dates.forEach(date => {
          runningTotal += dailyData[strategyId][date]
          dailyData[strategyId][date] = runningTotal
        })
      })
    }
    
    return NextResponse.json({
      success: true,
      period,
      metric,
      cumulative,
      data: dailyData,
      date_range: {
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0]
      }
    })
    
  } catch (error) {
    console.error('❌ Error fetching historical comparison data:', error)
    return NextResponse.json(
      { error: 'Failed to fetch historical data', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// Helper function to calculate strategy performance
function calculateStrategyPerformance(
  executions: any[],
  startDate: Date,
  endDate: Date
): StrategyPerformance {
  const completedTrades = executions.filter(e => e.status === 'completed' && e.final_pnl_percentage !== null)
  const winningTrades = completedTrades.filter(e => e.final_pnl_percentage > 0)
  const losingTrades = completedTrades.filter(e => e.final_pnl_percentage <= 0)
  
  const totalPnlSol = completedTrades.reduce((sum, e) => sum + (e.final_pnl_sol || 0), 0)
  const totalPnlPercentage = completedTrades.reduce((sum, e) => sum + (e.final_pnl_percentage || 0), 0)
  
  const gains = winningTrades.map(e => e.final_pnl_percentage || 0)
  const losses = losingTrades.map(e => e.final_pnl_percentage || 0)
  
  const averageGain = gains.length > 0 ? gains.reduce((sum, g) => sum + g, 0) / gains.length : 0
  const averageLoss = losses.length > 0 ? losses.reduce((sum, l) => sum + l, 0) / losses.length : 0
  
  const maxGain = gains.length > 0 ? Math.max(...gains) : 0
  const maxLoss = losses.length > 0 ? Math.min(...losses) : 0
  
  // Calculate Sharpe ratio (simplified)
  const returns = completedTrades.map(e => e.final_pnl_percentage || 0)
  const avgReturn = returns.length > 0 ? returns.reduce((sum, r) => sum + r, 0) / returns.length : 0
  const returnStdDev = returns.length > 1 
    ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1))
    : 0
  const sharpeRatio = returnStdDev > 0 ? avgReturn / returnStdDev : 0
  
  // Calculate max drawdown
  let maxDrawdown = 0
  let peak = 0
  let runningPnl = 0
  
  completedTrades
    .sort((a, b) => new Date(a.exit_time || '').getTime() - new Date(b.exit_time || '').getTime())
    .forEach(trade => {
      runningPnl += trade.final_pnl_sol || 0
      if (runningPnl > peak) {
        peak = runningPnl
      }
      const drawdown = peak > 0 ? (peak - runningPnl) / peak * 100 : 0
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown
      }
    })
  
  // Calculate daily PnL
  const dailyPnl: Record<string, number> = {}
  completedTrades.forEach(trade => {
    if (trade.exit_time) {
      const date = new Date(trade.exit_time).toISOString().split('T')[0]
      dailyPnl[date] = (dailyPnl[date] || 0) + (trade.final_pnl_sol || 0)
    }
  })
  
  // Calculate hourly performance
  const hourlyPerformance: Record<string, number> = {}
  for (let hour = 0; hour < 24; hour++) {
    const hourTrades = completedTrades.filter(t => 
      t.exit_time && new Date(t.exit_time).getHours() === hour
    )
    if (hourTrades.length > 0) {
      hourlyPerformance[hour.toString()] = hourTrades.reduce((sum, t) => sum + (t.final_pnl_percentage || 0), 0) / hourTrades.length
    }
  }
  
  return {
    total_trades: completedTrades.length,
    winning_trades: winningTrades.length,
    losing_trades: losingTrades.length,
    win_rate: completedTrades.length > 0 ? (winningTrades.length / completedTrades.length) * 100 : 0,
    total_pnl_sol: totalPnlSol,
    total_pnl_percentage: completedTrades.length > 0 ? totalPnlPercentage / completedTrades.length : 0,
    average_gain_percentage: averageGain,
    average_loss_percentage: averageLoss,
    max_gain_percentage: maxGain,
    max_loss_percentage: maxLoss,
    sharpe_ratio: sharpeRatio,
    max_drawdown_percentage: maxDrawdown,
    daily_pnl: dailyPnl,
    hourly_performance: hourlyPerformance,
    last_updated: new Date().toISOString()
  }
}

// Helper function to calculate composite score for ranking
function calculateCompositeScore(performance: StrategyPerformance): number {
  // Weighted scoring system
  const weights = {
    winRate: 0.25,
    totalPnl: 0.30,
    sharpeRatio: 0.20,
    maxDrawdown: 0.15, // Lower is better
    totalTrades: 0.10
  }
  
  const winRateScore = performance.win_rate / 100 // Normalize to 0-1
  const pnlScore = Math.max(0, Math.min(1, (performance.total_pnl_sol + 1) / 2)) // Normalize around 0
  const sharpeScore = Math.max(0, Math.min(1, (performance.sharpe_ratio || 0) / 3)) // Normalize to 0-1
  const drawdownScore = Math.max(0, 1 - (performance.max_drawdown_percentage / 100)) // Invert (lower is better)
  const tradesScore = Math.min(1, performance.total_trades / 50) // Normalize to 0-1, cap at 50 trades
  
  return (
    winRateScore * weights.winRate +
    pnlScore * weights.totalPnl +
    sharpeScore * weights.sharpeRatio +
    drawdownScore * weights.maxDrawdown +
    tradesScore * weights.totalTrades
  ) * 100 // Scale to 0-100
}

// Helper function to generate comparison insights
function generateComparisonInsights(
  strategies: any[],
  metrics: { [strategy_id: string]: StrategyPerformance }
): { recommendation: string; insights: string[] } {
  const insights: string[] = []
  
  // Find best performers in different categories
  let bestWinRate = { id: '', value: 0 }
  let bestPnL = { id: '', value: -Infinity }
  let bestSharpe = { id: '', value: -Infinity }
  let lowestDrawdown = { id: '', value: Infinity }
  
  Object.entries(metrics).forEach(([strategyId, performance]) => {
    if (performance.win_rate > bestWinRate.value) {
      bestWinRate = { id: strategyId, value: performance.win_rate }
    }
    if (performance.total_pnl_sol > bestPnL.value) {
      bestPnL = { id: strategyId, value: performance.total_pnl_sol }
    }
    if ((performance.sharpe_ratio || 0) > bestSharpe.value) {
      bestSharpe = { id: strategyId, value: performance.sharpe_ratio || 0 }
    }
    if (performance.max_drawdown_percentage < lowestDrawdown.value) {
      lowestDrawdown = { id: strategyId, value: performance.max_drawdown_percentage }
    }
  })
  
  // Generate insights
  const getStrategyName = (id: string) => strategies.find(s => s.id === id)?.name || id
  
  if (bestWinRate.value > 0) {
    insights.push(`${getStrategyName(bestWinRate.id)} has the highest win rate at ${bestWinRate.value.toFixed(1)}%`)
  }
  
  if (bestPnL.value > 0) {
    insights.push(`${getStrategyName(bestPnL.id)} generated the highest total PnL of ${bestPnL.value.toFixed(4)} SOL`)
  } else if (bestPnL.value < 0) {
    insights.push(`All strategies showed negative returns, with ${getStrategyName(bestPnL.id)} having the smallest loss`)
  }
  
  if (bestSharpe.value > 1) {
    insights.push(`${getStrategyName(bestSharpe.id)} shows the best risk-adjusted returns with a Sharpe ratio of ${bestSharpe.value.toFixed(2)}`)
  }
  
  if (lowestDrawdown.value < 20) {
    insights.push(`${getStrategyName(lowestDrawdown.id)} demonstrates the best risk management with only ${lowestDrawdown.value.toFixed(1)}% max drawdown`)
  }
  
  // Generate recommendation
  let recommendation = ''
  if (bestPnL.value > 0 && bestWinRate.value > 60) {
    recommendation = `Recommend ${getStrategyName(bestPnL.id)} for its strong combination of profitability and consistency.`
  } else if (bestWinRate.value > 70) {
    recommendation = `Consider ${getStrategyName(bestWinRate.id)} for its high win rate, but monitor position sizing.`
  } else if (lowestDrawdown.value < 15) {
    recommendation = `${getStrategyName(lowestDrawdown.id)} offers the most conservative approach with minimal drawdown.`
  } else {
    recommendation = 'All strategies need optimization. Consider adjusting risk parameters or entry criteria.'
  }
  
  return { recommendation, insights }
}