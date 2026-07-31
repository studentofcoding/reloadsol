// Types extracted from src/app/api/trending/track/route.ts (REL-19). No logic changes.

export interface PriceRecord {
  timestamp: string
  price_usd: number
  volume_5m: number | null
  market_cap?: number | null
}

export interface TrackedToken {
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
  status: 'waiting' | 'tracking' | 'won' | 'lost' | 'skipped' | 'stopped'
  organic_score: number | null
  market_cap: number | null
  volume_1h: number | null
  volume_5m: number | null
  tracking_started_at: string
  status_changed_at: string | null
  created_at: string
  updated_at: string
  trading_simulation?: TradingSimulation | null
  price_history?: PriceRecord[] | null
  // New fields for waiting system
  waiting_started_at?: string | null
  waiting_initial_price?: number | null
}

// Add TradingSimulation interfaces
export interface BuyOperation {
  timestamp: string
  buy_amount_sol: number
  token_amount_received: string
  buy_price_usd: number
  configurations: {
    slippage_1: BuyConfigResult
    slippage_2: BuyConfigResult
    slippage_3: BuyConfigResult
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
  // Enhanced bot tracking
  is_bot_operation?: boolean
  bot_strategy?: string
  signature?: string
}

export interface SellOperation {
  timestamp: string
  sell_amount_tokens: string
  sol_received: string
  sell_price_usd: number
  configurations: {
    slippage_1: SellConfigResult
    slippage_2: SellConfigResult
    slippage_3: SellConfigResult
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
  // Enhanced bot tracking
  is_bot_operation?: boolean
  bot_strategy?: string
  signature?: string
}

export interface BuyConfigResult {
  success: boolean
  response_time: number
  token_amount: string
  total_fees: number
  price_impact: string
  best_provider: string
  error?: string
}

export interface SellConfigResult {
  success: boolean
  response_time: number
  sol_amount: string
  total_fees: number
  price_impact: string
  best_provider: string
  error?: string
}

// Add type definition for trading simulation status
export type TradingSimulationStatus = 'buying' | 'holding' | 'selling' | 'completed' | 'failed'

export interface TradingSimulation {
  token_address: string
  token_symbol: string | null
  simulation_started_at: string
  buy_operation: BuyOperation | null
  sell_operations: SellOperation[]
  current_status: TradingSimulationStatus
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

export interface TradeExecutionParams {
  tokenAddress: string
  tokenSymbol: string | null
  inputMint: string
  outputMint: string
  amount: number // in lamports for input token
  slippageBps: number
  userPublicKey: string
  priorityFee?: number
  strategy?: string
  tokenData?: any // Add this field
}

export interface TradeExecutionResult {
  success: boolean
  signature?: string
  inputAmount: string
  outputAmount: string
  fees: {
    totalFees: number
    feePercentage: number
  }
  provider: string
  rpcUsed: string
  responseTime: number
  error?: string
}

export interface TradeExecutor {
  executeBuy(params: TradeExecutionParams): Promise<TradeExecutionResult>
  executeSell(params: TradeExecutionParams): Promise<TradeExecutionResult>
}

// Add synchronized trade execution interfaces
export interface SyncedTradeResult {
  simulation: TradeExecutionResult
  real?: TradeExecutionResult
  quote: any // The shared Jupiter quote
  deviation?: {
    outputAmountDiff: number
    outputAmountDiffPercent: number
    feesDiff: number
    responseTimeDiff: number
  }
}

// Add new interfaces for filtering tracking
export interface TokenFilterResult {
  token: any // Original pool data from Jupiter
  passed: boolean
  rejectionReasons: string[]
  mappedToken?: any // Mapped token data if passed
}

export interface RejectionDetail {
  reason: string
  count: number
  tokens: Array<{
    name: string
    symbol: string
    address: string
    price: number
    mcap?: number
    organicScore?: number
  }>
}

export interface FilteringSummary {
  totalTokens: number
  acceptedTokens: number
  rejectedTokens: number
  rejectionBreakdown: { [reason: string]: number }
  rejectionDetails: RejectionDetail[] // New field for detailed token info
  processingTime: number
}

// Add interface for price tracking
export interface PriceTracking {
  initialPrice: number
  currentPrice: number
  peakPrice: number
  currentGain: number
  peakGain: number
  lastUpdated: string
}
