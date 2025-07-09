// Trading Strategy Management System
// This file defines the interfaces and types for managing multiple trading strategies

export interface TradingStrategy {
  id: string
  name: string
  description: string
  enabled: boolean
  created_at: string
  updated_at: string
  
  // Strategy Configuration
  config: StrategyConfig
  
  // Performance Metrics
  performance: StrategyPerformance
  
  // Risk Management
  risk_management: RiskManagement
  
  // Filtering Criteria
  token_filters: TokenFilters
  
  // Trading Parameters
  trading_params: TradingParameters
}

export interface StrategyConfig {
  // Strategy Type
  strategy_type: 'conservative' | 'aggressive' | 'scalping' | 'swing' | 'momentum' | 'custom'
  
  // Allocation
  max_concurrent_positions: number
  position_size_sol: number
  max_daily_trades: number
  
  // Time-based settings
  max_hold_hours: number
  min_hold_minutes: number
  
  // Strategy-specific parameters
  custom_params?: Record<string, any>
}

export interface StrategyPerformance {
  total_trades: number
  winning_trades: number
  losing_trades: number
  win_rate: number
  
  total_pnl_sol: number
  total_pnl_percentage: number
  average_gain_percentage: number
  average_loss_percentage: number
  max_gain_percentage: number
  max_loss_percentage: number
  
  sharpe_ratio?: number
  max_drawdown_percentage: number
  
  // Time-based performance
  daily_pnl: Record<string, number> // date -> pnl
  hourly_performance: Record<string, number> // hour -> avg performance
  
  last_updated: string
}

export interface RiskManagement {
  // Stop Loss Configuration
  stop_loss_percentage: number
  trailing_stop_enabled: boolean
  trailing_stop_percentage?: number
  
  // Take Profit Configuration
  take_profit_levels: {
    tp1_percentage: number
    tp1_sell_percentage: number // % of position to sell at TP1
    tp2_percentage: number
    tp2_sell_percentage: number
    tp3_percentage: number
    tp3_sell_percentage: number
    tp3_enabled: boolean
  }
  
  // Risk Limits
  max_loss_per_day_sol: number
  max_loss_per_trade_sol: number
  position_sizing_method: 'fixed' | 'percentage' | 'kelly' | 'volatility_adjusted'
  
  // Circuit Breakers
  daily_loss_circuit_breaker: number // Stop trading if daily loss exceeds this
  consecutive_loss_limit: number // Stop after N consecutive losses
}

export interface TokenFilters {
  // Market Cap Filters
  min_market_cap: number
  max_market_cap: number
  
  // Volume Filters
  min_volume_1h: number
  min_volume_5m?: number
  
  // Price Change Filters
  min_price_change_5m: number // e.g., -40% to avoid crashes
  max_price_change_5m?: number // e.g., 500% to avoid extreme pumps
  min_price_change_1h?: number
  max_price_change_1h?: number
  
  // Quality Filters
  min_organic_score: number
  min_net_buyers_1h?: number
  
  // Exclusion Filters
  excluded_tokens: string[] // Token addresses to exclude
  excluded_symbols: string[] // Token symbols to exclude
  
  // Custom Filters
  custom_filters?: {
    name: string
    condition: string // JavaScript expression
    enabled: boolean
  }[]
}

export interface TradingParameters {
  // Entry Logic
  entry_strategy: 'immediate' | 'wait_for_dip' | 'momentum_breakout' | 'mean_reversion'
  entry_conditions: {
    dip_percentage?: number // For wait_for_dip strategy
    momentum_threshold?: number // For momentum_breakout
    rsi_oversold?: number // For mean_reversion
    volume_spike_multiplier?: number
  }
  
  // Exit Logic
  exit_strategy: 'take_profit_stop_loss' | 'trailing_stop' | 'time_based' | 'technical_indicators'
  exit_conditions: {
    time_based_exit_hours?: number
    rsi_overbought?: number
    volume_decline_threshold?: number
  }
  
  // Order Management
  slippage_tolerance_bps: number
  priority_fee_sol: number
  retry_attempts: number
  retry_delay_ms: number
}

// Strategy Execution State
export interface StrategyExecution {
  strategy_id: string
  token_address: string
  token_symbol: string
  status: 'active' | 'completed' | 'failed' | 'cancelled'
  
  entry_time: string
  entry_price: number
  entry_amount_sol: number
  
  current_price?: number
  current_pnl_percentage?: number
  current_pnl_sol?: number
  
  exit_time?: string
  exit_price?: number
  exit_reason?: 'take_profit' | 'stop_loss' | 'time_limit' | 'manual' | 'circuit_breaker'
  
  final_pnl_percentage?: number
  final_pnl_sol?: number
  
  trade_log: TradeLogEntry[]
}

export interface TradeLogEntry {
  timestamp: string
  action: 'buy' | 'sell' | 'price_update' | 'signal' | 'error'
  price: number
  amount?: number
  message: string
  metadata?: Record<string, any>
}

// Strategy Comparison and Backtesting
export interface StrategyComparison {
  strategies: string[] // Strategy IDs
  comparison_period: {
    start_date: string
    end_date: string
  }
  metrics: {
    [strategy_id: string]: StrategyPerformance
  }
  winner: string // Best performing strategy ID
  recommendation: string
}

export interface BacktestResult {
  strategy_id: string
  backtest_period: {
    start_date: string
    end_date: string
  }
  total_trades: number
  performance: StrategyPerformance
  trade_history: StrategyExecution[]
  equity_curve: { timestamp: string; equity: number }[]
  drawdown_periods: { start: string; end: string; max_drawdown: number }[]
}

// Strategy Management API Types
export interface CreateStrategyRequest {
  name: string
  description: string
  config: StrategyConfig
  risk_management: RiskManagement
  token_filters: TokenFilters
  trading_params: TradingParameters
}

export interface UpdateStrategyRequest {
  strategy_id: string
  updates: Partial<TradingStrategy>
}

export interface StrategyTestRequest {
  strategy_id: string
  test_duration_hours: number
  max_test_trades: number
  paper_trading_only: boolean
}

// Pre-defined Strategy Templates
export const STRATEGY_TEMPLATES: Record<string, Partial<TradingStrategy>> = {
  conservative: {
    name: 'Conservative Growth',
    description: 'Low-risk strategy focusing on stable gains with tight stop losses',
    config: {
      strategy_type: 'conservative',
      max_concurrent_positions: 3,
      position_size_sol: 0.01,
      max_daily_trades: 5,
      max_hold_hours: 12,
      min_hold_minutes: 30
    },
    risk_management: {
      stop_loss_percentage: -25,
      trailing_stop_enabled: true,
      trailing_stop_percentage: -15,
      take_profit_levels: {
        tp1_percentage: 30,
        tp1_sell_percentage: 50,
        tp2_percentage: 60,
        tp2_sell_percentage: 30,
        tp3_percentage: 100,
        tp3_sell_percentage: 20,
        tp3_enabled: true
      },
      max_loss_per_day_sol: 0.05,
      max_loss_per_trade_sol: 0.015,
      position_sizing_method: 'fixed',
      daily_loss_circuit_breaker: -0.1,
      consecutive_loss_limit: 3
    }
  },
  
  aggressive: {
    name: 'Aggressive Momentum',
    description: 'High-risk, high-reward strategy targeting momentum plays',
    config: {
      strategy_type: 'aggressive',
      max_concurrent_positions: 8,
      position_size_sol: 0.02,
      max_daily_trades: 15,
      max_hold_hours: 6,
      min_hold_minutes: 15
    },
    risk_management: {
      stop_loss_percentage: -40,
      trailing_stop_enabled: false,
      take_profit_levels: {
        tp1_percentage: 80,
        tp1_sell_percentage: 60,
        tp2_percentage: 150,
        tp2_sell_percentage: 30,
        tp3_percentage: 300,
        tp3_sell_percentage: 10,
        tp3_enabled: true
      },
      max_loss_per_day_sol: 0.15,
      max_loss_per_trade_sol: 0.03,
      position_sizing_method: 'percentage',
      daily_loss_circuit_breaker: -0.25,
      consecutive_loss_limit: 5
    }
  },
  
  scalping: {
    name: 'Quick Scalp',
    description: 'Fast in-and-out trades targeting small but frequent gains',
    config: {
      strategy_type: 'scalping',
      max_concurrent_positions: 5,
      position_size_sol: 0.015,
      max_daily_trades: 25,
      max_hold_hours: 2,
      min_hold_minutes: 5
    },
    risk_management: {
      stop_loss_percentage: -20,
      trailing_stop_enabled: true,
      trailing_stop_percentage: -10,
      take_profit_levels: {
        tp1_percentage: 15,
        tp1_sell_percentage: 70,
        tp2_percentage: 25,
        tp2_sell_percentage: 25,
        tp3_percentage: 40,
        tp3_sell_percentage: 5,
        tp3_enabled: false
      },
      max_loss_per_day_sol: 0.08,
      max_loss_per_trade_sol: 0.02,
      position_sizing_method: 'fixed',
      daily_loss_circuit_breaker: -0.15,
      consecutive_loss_limit: 4
    }
  }
}