export type StrategyDomain = 'trending_bot' | 'signals' | 'dlmm' | 'mcap_tracker'

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
  execution_mode?: ExecutionMode
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
    /** Minimum growth % for hold when minGrowth is 0 (default applied in scoring) */
    holdGrowthFloor?: number
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
  execution: {
    simDeploySol: number
    maxOpenPositions: number
    minCandidateScore: number
  }
}

export type DlmmStrategyOverride = Partial<
  Omit<DlmmStrategyConfig, 'execution'>
> & {
  execution?: Partial<DlmmStrategyConfig['execution']>
}

export interface DlmmStrategy {
  id: string
  name: string
  description: string
  is_active: boolean
  execution_mode: ExecutionMode
  config: DlmmStrategyConfig
}

export type McapTrackerEntryTemplate = 'first_seen' | 'milestone_80'

export interface McapTrackerStrategyConfig {
  entryTemplate: McapTrackerEntryTemplate
  query: {
    recencyMinutes: number
    limit?: number
  }
  execution: {
    simBuySol: number
    maxOpenPositions: number
  }
  exit: {
    stopLossPct: number
    takeProfitPct: number
    maxHoldHours: number
  }
  entry: {
    mcapMin: number
    mcapMax: number
    organicScoreMin?: number
    topHoldersPctMax?: number
  }
}

export type McapTrackerStrategyOverride = Partial<
  Omit<McapTrackerStrategyConfig, 'query' | 'execution' | 'exit' | 'entry'>
> & {
  query?: Partial<McapTrackerStrategyConfig['query']>
  execution?: Partial<McapTrackerStrategyConfig['execution']>
  exit?: Partial<McapTrackerStrategyConfig['exit']>
  entry?: Partial<McapTrackerStrategyConfig['entry']>
}

export interface McapTrackerStrategy {
  id: string
  name: string
  description: string
  is_active: boolean
  execution_mode: ExecutionMode
  config: McapTrackerStrategyConfig
}

export interface McapTrackerMilestoneBucket {
  bucket: 'all' | 'reached_80' | 'reached_120' | 'reached_200'
  label: string
  trade_count: number
  win_count: number
  win_rate: number
  avg_pnl_pct: number
}

export interface McapTrackerReportStats {
  strategies: StrategyReportBreakdown[]
  milestone_buckets: McapTrackerMilestoneBucket[]
  timeline_inconsistent_count: number
  total_tracked_tokens: number
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

export type OutcomeMlLabel = 'skip' | 'interesting' | 'anomaly'

export type OutcomeMlCondition = 'old_chart' | 'price_topped' | 'new_chart'

export type TrainingClass = 0 | 1 | 2 | 3 | 4 | null

export interface OutcomeMlMetadata {
  ml_label?: OutcomeMlLabel | null
  ml_condition?: OutcomeMlCondition | null
  ml_note?: string | null
  ml_labeled_at?: string | null
  ml_condition_at?: string | null
  ml_manual?: boolean
  training_class?: TrainingClass
  regime_tag_at_exit?: string | null
}

export interface OutcomeChartPoint {
  timestamp: string
  price_usd: number
  volume_5m?: number | null
}

export type OutcomeChartSource = 'tracker' | 'outcome_features' | 'synthetic' | 'empty'

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
  open_tracker_count?: number | null
  ml_unlabeled?: number
  ml_labeled?: number
}

export interface MlLabelStats {
  total: number
  unlabeled: number
  by_label: Record<string, number>
  by_condition: Record<string, number>
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
  executionModes: Record<string, ExecutionMode>
}
