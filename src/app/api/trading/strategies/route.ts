import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'
import { supabase } from '@/utils/supabase'
import {
  TradingStrategy,
  StrategyPerformance,
  CreateStrategyRequest,
  UpdateStrategyRequest,
  StrategyTestRequest,
  StrategyComparison,
  BacktestResult,
  STRATEGY_TEMPLATES
} from '@/types/trading-strategies'

export const runtime = 'edge'

// Table names
const STRATEGIES_TABLE = process.env.NODE_ENV === 'development' ? 'trading_strategies_dev' : 'trading_strategies'
const STRATEGY_EXECUTIONS_TABLE = process.env.NODE_ENV === 'development' ? 'strategy_executions_dev' : 'strategy_executions'
const STRATEGY_PERFORMANCE_TABLE = process.env.NODE_ENV === 'development' ? 'strategy_performance_dev' : 'strategy_performance'

// GET - List all strategies with performance metrics
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const includePerformance = searchParams.get('include_performance') === 'true'
    const enabledOnly = searchParams.get('enabled_only') === 'true'
    const strategyType = searchParams.get('strategy_type')
    
    let query = supabase.from(STRATEGIES_TABLE).select('*')
    
    if (enabledOnly) {
      query = query.eq('enabled', true)
    }
    
    if (strategyType) {
      query = query.eq('config->strategy_type', strategyType)
    }
    
    const { data: strategies, error } = await query.order('created_at', { ascending: false })
    
    if (error) {
      throw new Error(`Failed to fetch strategies: ${error.message}`)
    }
    
    // Include performance metrics if requested
    if (includePerformance && strategies) {
      for (const strategy of strategies) {
        const performance = await getStrategyPerformance(strategy.id)
        strategy.performance = performance
      }
    }
    
    return NextResponse.json({
      success: true,
      strategies: strategies || [],
      total: strategies?.length || 0
    })
    
  } catch (error) {
    console.error('❌ Error fetching strategies:', error)
    return NextResponse.json(
      { error: 'Failed to fetch strategies', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// POST - Create new strategy
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as CreateStrategyRequest
    
    // Validate required fields
    if (!body.name || !body.config || !body.risk_management || !body.token_filters || !body.trading_params) {
      return NextResponse.json(
        { error: 'Missing required fields: name, config, risk_management, token_filters, trading_params' },
        { status: 400 }
      )
    }
    
    // Create strategy object
    const strategy: Omit<TradingStrategy, 'id'> = {
      name: body.name,
      description: body.description,
      enabled: false, // New strategies start disabled
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      config: body.config,
      performance: {
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
      },
      risk_management: body.risk_management,
      token_filters: body.token_filters,
      trading_params: body.trading_params
    }
    
    // Insert into database
    const { data, error } = await supabase
      .from(STRATEGIES_TABLE)
      .insert(strategy)
      .select()
      .single()
    
    if (error) {
      throw new Error(`Failed to create strategy: ${error.message}`)
    }
    
    return NextResponse.json({
      success: true,
      strategy: data,
      message: 'Strategy created successfully'
    })
    
  } catch (error) {
    console.error('❌ Error creating strategy:', error)
    return NextResponse.json(
      { error: 'Failed to create strategy', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// PUT - Update existing strategy
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json() as UpdateStrategyRequest
    
    if (!body.strategy_id) {
      return NextResponse.json(
        { error: 'Missing required field: strategy_id' },
        { status: 400 }
      )
    }
    
    // Add updated_at timestamp
    const updates = {
      ...body.updates,
      updated_at: new Date().toISOString()
    }
    
    const { data, error } = await supabase
      .from(STRATEGIES_TABLE)
      .update(updates)
      .eq('id', body.strategy_id)
      .select()
      .single()
    
    if (error) {
      throw new Error(`Failed to update strategy: ${error.message}`)
    }
    
    return NextResponse.json({
      success: true,
      strategy: data,
      message: 'Strategy updated successfully'
    })
    
  } catch (error) {
    console.error('❌ Error updating strategy:', error)
    return NextResponse.json(
      { error: 'Failed to update strategy', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// DELETE - Delete strategy
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const strategyId = searchParams.get('strategy_id')
    
    if (!strategyId) {
      return NextResponse.json(
        { error: 'Missing required parameter: strategy_id' },
        { status: 400 }
      )
    }
    
    // Check if strategy has active executions
    const { data: activeExecutions } = await supabase
      .from(STRATEGY_EXECUTIONS_TABLE)
      .select('id')
      .eq('strategy_id', strategyId)
      .eq('status', 'active')
    
    if (activeExecutions && activeExecutions.length > 0) {
      return NextResponse.json(
        { error: 'Cannot delete strategy with active executions. Please stop all active trades first.' },
        { status: 400 }
      )
    }
    
    // Delete strategy
    const { error } = await supabase
      .from(STRATEGIES_TABLE)
      .delete()
      .eq('id', strategyId)
    
    if (error) {
      throw new Error(`Failed to delete strategy: ${error.message}`)
    }
    
    return NextResponse.json({
      success: true,
      message: 'Strategy deleted successfully'
    })
    
  } catch (error) {
    console.error('❌ Error deleting strategy:', error)
    return NextResponse.json(
      { error: 'Failed to delete strategy', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// Helper function to get strategy performance
async function getStrategyPerformance(strategyId: string): Promise<StrategyPerformance> {
  try {
    // Get all completed executions for this strategy
    const { data: executions, error } = await supabase
      .from(STRATEGY_EXECUTIONS_TABLE)
      .select('*')
      .eq('strategy_id', strategyId)
      .in('status', ['completed', 'failed'])
    
    if (error) {
      throw new Error(`Failed to fetch executions: ${error.message}`)
    }
    
    if (!executions || executions.length === 0) {
      return {
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
    }
    
    // Calculate performance metrics
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
    completedTrades.forEach(trade => {
      if (trade.exit_time) {
        const hour = new Date(trade.exit_time).getHours().toString()
        const trades = completedTrades.filter(t => 
          t.exit_time && new Date(t.exit_time).getHours().toString() === hour
        )
        if (trades.length > 0) {
          hourlyPerformance[hour] = trades.reduce((sum, t) => sum + (t.final_pnl_percentage || 0), 0) / trades.length
        }
      }
    })
    
    // Calculate max drawdown (simplified)
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
        const drawdown = (peak - runningPnl) / Math.max(peak, 0.001) * 100
        if (drawdown > maxDrawdown) {
          maxDrawdown = drawdown
        }
      })
    
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
      max_drawdown_percentage: maxDrawdown,
      daily_pnl: dailyPnl,
      hourly_performance: hourlyPerformance,
      last_updated: new Date().toISOString()
    }
    
  } catch (error) {
    console.error('❌ Error calculating strategy performance:', error)
    throw error
  }
}