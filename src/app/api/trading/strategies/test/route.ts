import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'
import { supabase } from '@/utils/supabase'
import {
  TradingStrategy,
  StrategyTestRequest,
  StrategyExecution,
  TradeLogEntry
} from '@/types/trading-strategies'

export const runtime = 'edge'

// Table names
const STRATEGIES_TABLE = process.env.NODE_ENV === 'development' ? 'trading_strategies_dev' : 'trading_strategies'
const STRATEGY_EXECUTIONS_TABLE = process.env.NODE_ENV === 'development' ? 'strategy_executions_dev' : 'strategy_executions'
const STRATEGY_TESTS_TABLE = process.env.NODE_ENV === 'development' ? 'strategy_tests_dev' : 'strategy_tests'

// POST - Start strategy test
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as StrategyTestRequest
    
    if (!body.strategy_id) {
      return NextResponse.json(
        { error: 'Missing required field: strategy_id' },
        { status: 400 }
      )
    }
    
    // Get strategy details
    const { data: strategy, error: strategyError } = await supabase
      .from(STRATEGIES_TABLE)
      .select('*')
      .eq('id', body.strategy_id)
      .single()
    
    if (strategyError || !strategy) {
      return NextResponse.json(
        { error: 'Strategy not found' },
        { status: 404 }
      )
    }
    
    // Check if strategy is already being tested
    const { data: existingTest } = await supabase
      .from(STRATEGY_TESTS_TABLE)
      .select('id')
      .eq('strategy_id', body.strategy_id)
      .eq('status', 'running')
      .single()
    
    if (existingTest) {
      return NextResponse.json(
        { error: 'Strategy is already being tested' },
        { status: 400 }
      )
    }
    
    // Create test record
    const testRecord = {
      strategy_id: body.strategy_id,
      test_duration_hours: body.test_duration_hours || 24,
      max_test_trades: body.max_test_trades || 10,
      paper_trading_only: body.paper_trading_only !== false, // Default to true
      status: 'running',
      started_at: new Date().toISOString(),
      test_results: {
        trades_executed: 0,
        current_pnl: 0,
        max_drawdown: 0,
        signals_generated: 0
      }
    }
    
    const { data: test, error: testError } = await supabase
      .from(STRATEGY_TESTS_TABLE)
      .insert(testRecord)
      .select()
      .single()
    
    if (testError) {
      throw new Error(`Failed to create test record: ${testError.message}`)
    }
    
    // Enable strategy for testing (temporarily)
    await supabase
      .from(STRATEGIES_TABLE)
      .update({ 
        enabled: true,
        updated_at: new Date().toISOString()
      })
      .eq('id', body.strategy_id)
    
    // Schedule test completion
    setTimeout(async () => {
      await completeStrategyTest(test.id, body.strategy_id)
    }, (body.test_duration_hours || 24) * 60 * 60 * 1000)
    
    return NextResponse.json({
      success: true,
      test_id: test.id,
      message: `Strategy test started. Will run for ${body.test_duration_hours || 24} hours or ${body.max_test_trades || 10} trades.`,
      test_details: test
    })
    
  } catch (error) {
    console.error('❌ Error starting strategy test:', error)
    return NextResponse.json(
      { error: 'Failed to start strategy test', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// GET - Get test status and results
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const testId = searchParams.get('test_id')
    const strategyId = searchParams.get('strategy_id')
    
    if (!testId && !strategyId) {
      return NextResponse.json(
        { error: 'Missing required parameter: test_id or strategy_id' },
        { status: 400 }
      )
    }
    
    let query = supabase.from(STRATEGY_TESTS_TABLE).select('*')
    
    if (testId) {
      query = query.eq('id', testId)
    } else if (strategyId) {
      query = query.eq('strategy_id', strategyId).order('started_at', { ascending: false })
    }
    
    const { data: tests, error } = await query
    
    if (error) {
      throw new Error(`Failed to fetch test results: ${error.message}`)
    }
    
    if (!tests || tests.length === 0) {
      return NextResponse.json(
        { error: 'Test not found' },
        { status: 404 }
      )
    }
    
    // Get detailed results for each test
    const detailedTests = await Promise.all(
      tests.map(async (test) => {
        // Get executions for this test period
        const { data: executions } = await supabase
          .from(STRATEGY_EXECUTIONS_TABLE)
          .select('*')
          .eq('strategy_id', test.strategy_id)
          .gte('entry_time', test.started_at)
          .lte('entry_time', test.completed_at || new Date().toISOString())
        
        return {
          ...test,
          executions: executions || []
        }
      })
    )
    
    return NextResponse.json({
      success: true,
      tests: testId ? detailedTests[0] : detailedTests
    })
    
  } catch (error) {
    console.error('❌ Error fetching test results:', error)
    return NextResponse.json(
      { error: 'Failed to fetch test results', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// DELETE - Stop running test
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const testId = searchParams.get('test_id')
    
    if (!testId) {
      return NextResponse.json(
        { error: 'Missing required parameter: test_id' },
        { status: 400 }
      )
    }
    
    // Get test details
    const { data: test, error: testError } = await supabase
      .from(STRATEGY_TESTS_TABLE)
      .select('*')
      .eq('id', testId)
      .single()
    
    if (testError || !test) {
      return NextResponse.json(
        { error: 'Test not found' },
        { status: 404 }
      )
    }
    
    if (test.status !== 'running') {
      return NextResponse.json(
        { error: 'Test is not currently running' },
        { status: 400 }
      )
    }
    
    // Complete the test
    await completeStrategyTest(testId, test.strategy_id)
    
    return NextResponse.json({
      success: true,
      message: 'Strategy test stopped successfully'
    })
    
  } catch (error) {
    console.error('❌ Error stopping strategy test:', error)
    return NextResponse.json(
      { error: 'Failed to stop strategy test', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// Helper function to complete strategy test
async function completeStrategyTest(testId: string, strategyId: string) {
  try {
    // Get test details
    const { data: test } = await supabase
      .from(STRATEGY_TESTS_TABLE)
      .select('*')
      .eq('id', testId)
      .single()
    
    if (!test || test.status !== 'running') {
      return
    }
    
    // Get executions during test period
    const { data: executions } = await supabase
      .from(STRATEGY_EXECUTIONS_TABLE)
      .select('*')
      .eq('strategy_id', strategyId)
      .gte('entry_time', test.started_at)
    
    // Calculate test results
    const completedTrades = executions?.filter(e => e.status === 'completed') || []
    const totalPnl = completedTrades.reduce((sum, e) => sum + (e.final_pnl_sol || 0), 0)
    const winningTrades = completedTrades.filter(e => (e.final_pnl_percentage || 0) > 0)
    
    // Calculate max drawdown during test
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
    
    const testResults = {
      trades_executed: completedTrades.length,
      current_pnl: totalPnl,
      max_drawdown: maxDrawdown,
      win_rate: completedTrades.length > 0 ? (winningTrades.length / completedTrades.length) * 100 : 0,
      average_trade_duration: completedTrades.length > 0 
        ? completedTrades.reduce((sum, t) => {
            const duration = t.exit_time && t.entry_time 
              ? (new Date(t.exit_time).getTime() - new Date(t.entry_time).getTime()) / (1000 * 60 * 60)
              : 0
            return sum + duration
          }, 0) / completedTrades.length
        : 0,
      signals_generated: executions?.length || 0
    }
    
    // Update test record
    await supabase
      .from(STRATEGY_TESTS_TABLE)
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        test_results: testResults
      })
      .eq('id', testId)
    
    // Disable strategy after test (unless it was already enabled)
    const { data: strategy } = await supabase
      .from(STRATEGIES_TABLE)
      .select('enabled')
      .eq('id', strategyId)
      .single()
    
    // Only disable if this was a test activation
    if (strategy && test.paper_trading_only) {
      await supabase
        .from(STRATEGIES_TABLE)
        .update({ 
          enabled: false,
          updated_at: new Date().toISOString()
        })
        .eq('id', strategyId)
    }
    
    console.log(`✅ Strategy test ${testId} completed with results:`, testResults)
    
  } catch (error) {
    console.error('❌ Error completing strategy test:', error)
    
    // Mark test as failed
    await supabase
      .from(STRATEGY_TESTS_TABLE)
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: error instanceof Error ? error.message : 'Unknown error'
      })
      .eq('id', testId)
  }
}