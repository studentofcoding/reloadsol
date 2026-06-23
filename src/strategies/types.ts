export type StrategyDomain = 'trending_bot' | 'signals' | 'dlmm'

export type ExecutionMode = 'sim_only' | 'live_only' | 'ab_parallel'

export type RiskLevel = 'low' | 'medium' | 'high'

export interface TokenFilterConfig {
  enabled: boolean
  mcap?: { min?: number; max?: number }
  priceChange5m?: { min?: number; max?: number }
  priceChange1h?: { min?: number; max?: number }
  priceChange6h?: { min?: number; max?: number }
  organicScore?: { min?: number }
  topHoldersPercentage?: { max?: number }
  requireCompleteData?: boolean
  checkManualTradingHistory?: boolean
}

export interface TrendingBotStrategy {
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
    max_risk_level?: RiskLevel
  }
  filtering?: TokenFilterConfig
  allocation_weight?: number
}

export type TrendingBotStrategyOverride = Partial<
  Omit<TrendingBotStrategy, 'id'>
> & {
  take_profit_levels?: Partial<TrendingBotStrategy['take_profit_levels']>
  conditions?: Partial<NonNullable<TrendingBotStrategy['conditions']>>
  filtering?: Partial<TokenFilterConfig>
}

export interface SignalsScoringWeights {
  recencyBoostMax: number
  milestone80: number
  milestone120: number
  milestone200: number
  speedTo80Fast: number
  speedTo80Medium: number
  speedTo80Slow: number
  inTrackingRange: number
  stuckPenalty: number
  stopLossPenalty: number
  sellOver100LatePenalty: number
}

export interface SignalsStrategyConfig {
  template: 'default' | 'sell_over_100'
  query: {
    limit: number
    recencyMinutes: number
    minGrowth: number
    includeStuck: boolean
    maxAgeMinutes: number
  }
  scoring: SignalsScoringWeights
  enterScoreFloor: number
  execution: {
    simBuySol: number
    maxOpenPositions: number
  }
}

export type SignalsStrategyOverride = Partial<
  Omit<SignalsStrategyConfig, 'template' | 'query' | 'scoring' | 'execution'>
> & {
  query?: Partial<SignalsStrategyConfig['query']>
  scoring?: Partial<SignalsScoringWeights>
  execution?: Partial<SignalsStrategyConfig['execution']>
}

export interface SignalsStrategy {
  id: string
  name: string
  description: string
  is_active: boolean
  execution_mode: ExecutionMode
  config: SignalsStrategyConfig
}

export interface DlmmStrategyConfig {
  min_tvl: number
  min_fee_tvl: number
  min_organic_score: number
  min_holders: number
  take_profit_pct: number
  stop_loss_pct: number
  oor_timeout_min: number
  max_sol_per_position: number
  max_sol_at_risk: number
  bin_range_interval: number
}

export type DlmmStrategyOverride = Partial<DlmmStrategyConfig>

export interface DlmmStrategy {
  id: string
  name: string
  description: string
  is_active: boolean
  execution_mode: ExecutionMode
  config: DlmmStrategyConfig
}

export interface StrategyDefinitionRow {
  id: string
  domain: StrategyDomain
  name: string
  description: string | null
  config: Record<string, unknown>
  is_active: boolean
  execution_mode: ExecutionMode
  version: number
  updated_at: string
}

export interface StrategyOutcomeRow {
  id: string
  strategy_id: string
  domain: StrategyDomain
  token_address: string | null
  entry_at: string | null
  exit_at: string | null
  pnl_pct: number | null
  status: string | null
  is_simulated: boolean
  features: Record<string, unknown> | null
  created_at: string
}

export interface StrategyReportBreakdown {
  strategy_id: string
  domain: StrategyDomain
  is_simulated: boolean
  trade_count: number
  win_count: number
  loss_count: number
  win_rate: number
  avg_pnl_pct: number
  median_pnl_pct: number
  total_pnl_pct: number
  last_exit_at?: string | null
}

export interface StrategyCoverageRow {
  strategy_id: string
  domain: StrategyDomain
  name: string
  is_active: boolean
  execution_mode: ExecutionMode
  sim_trade_count: number
  live_trade_count: number
  last_exit_at: string | null
  avg_pnl_pct: number | null
}

export interface StrategyAbPair {
  strategy_id: string
  domain: StrategyDomain
  sim: StrategyReportBreakdown | null
  live: StrategyReportBreakdown | null
}

export interface SignalsStrategyMeta {
  id: 'default' | 'sell_over_100'
  name: string
  description: string
  params: {
    minGrowthDefault: number
    recencyMinutesDefault: number
    enterScoreFloor: number
  }
}

export interface ActiveStrategiesResult {
  strategies: string[]
  configs: Record<string, TrendingBotStrategy>
  allocation: Record<string, number>
}
