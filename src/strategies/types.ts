export type StrategyDomain = 'trending_bot' | 'signals' | 'dlmm'

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

export interface StrategyDefinitionRow {
  id: string
  domain: StrategyDomain
  name: string
  description: string | null
  config: TrendingBotStrategyOverride
  is_active: boolean
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
  features: Record<string, unknown> | null
  created_at: string
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
