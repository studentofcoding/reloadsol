import { TradingStrategy } from '@/types/trading-strategies'

/**
 * Creates a fallback trading strategy when no suitable strategies are found
 * This ensures the system always has a strategy to use for token trading
 */
export function createFallbackStrategy(): TradingStrategy {
  return {
    id: 'fallback',
    name: 'Fallback Conservative',
    description: 'Default fallback strategy when no strategies are enabled',
    enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    config: {
      strategy_type: 'conservative',
      max_concurrent_positions: 5,
      position_size_sol: 0.1,
      max_daily_trades: 10,
      max_hold_hours: 24,
      min_hold_minutes: 5
    },
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
    risk_management: {
      stop_loss_percentage: -50,
      trailing_stop_enabled: false,
      take_profit_levels: {
        tp1_percentage: 60,
        tp1_sell_percentage: 80,
        tp2_percentage: 100,
        tp2_sell_percentage: 100,
        tp3_percentage: 150,
        tp3_sell_percentage: 100,
        tp3_enabled: false
      },
      max_loss_per_day_sol: 1.0,
      max_loss_per_trade_sol: 0.1,
      position_sizing_method: 'fixed',
      daily_loss_circuit_breaker: -2.0,
      consecutive_loss_limit: 5
    },
    token_filters: {
      min_market_cap: 300_000,
      max_market_cap: 2_000_000,
      min_volume_1h: 10_000,
      min_price_change_5m: -40,
      max_price_change_5m: 500,
      min_organic_score: 65,
      excluded_tokens: [],
      excluded_symbols: []
    },
    trading_params: {
      entry_strategy: 'immediate',
      entry_conditions: {
        dip_percentage: 15,
        momentum_threshold: 120
      },
      exit_strategy: 'take_profit_stop_loss',
      exit_conditions: {
        time_based_exit_hours: 24
      },
      slippage_tolerance_bps: 300,
      priority_fee_sol: 0.001,
      retry_attempts: 3,
      retry_delay_ms: 1000
    }
  }
}

/**
 * Creates a custom fallback strategy with specific parameters
 * Useful for testing different fallback configurations
 */
export function createCustomFallbackStrategy(overrides: Partial<TradingStrategy> = {}): TradingStrategy {
  const baseStrategy = createFallbackStrategy()
  
  return {
    ...baseStrategy,
    ...overrides,
    config: {
      ...baseStrategy.config,
      ...overrides.config
    },
    performance: {
      ...baseStrategy.performance,
      ...overrides.performance
    },
    risk_management: {
      ...baseStrategy.risk_management,
      ...overrides.risk_management,
      take_profit_levels: {
        ...baseStrategy.risk_management.take_profit_levels,
        ...overrides.risk_management?.take_profit_levels
      }
    },
    token_filters: {
      ...baseStrategy.token_filters,
      ...overrides.token_filters
    },
    trading_params: {
      ...baseStrategy.trading_params,
      ...overrides.trading_params,
      entry_conditions: {
        ...baseStrategy.trading_params.entry_conditions,
        ...overrides.trading_params?.entry_conditions
      },
      exit_conditions: {
        ...baseStrategy.trading_params.exit_conditions,
        ...overrides.trading_params?.exit_conditions
      }
    }
  }
}