export type DlmmPositionStatus = 'open' | 'closed' | 'pending' | 'out_of_range';
export type DlmmDecision = 'STAY' | 'CLOSE' | 'REDEPLOY' | 'DEPLOY' | 'MUTE';
export type DlmmStrategyType = 'spot' | 'bid_ask' | 'curve';

export interface MeteoraTokenInfo {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  holders?: number;
  price?: number;
  market_cap?: number;
}

export interface MeteoraPoolConfig {
  bin_step: number;
  base_fee_pct: number;
  max_fee_pct: number;
  protocol_fee_pct: number;
  collect_fee_mode: number;
}

export interface MeteoraPool {
  address: string;
  name: string;
  token_x: MeteoraTokenInfo;
  token_y: MeteoraTokenInfo;
  tvl: number;
  current_price: number;
  apr?: number;
  apy?: number;
  dynamic_fee_pct?: number;
  pool_config: MeteoraPoolConfig;
  volume?: Record<string, number>;
  fees?: Record<string, number>;
  fee_tvl_ratio?: Record<string, number>;
  created_at?: number;
  tags?: string[];
}

export interface MeteoraPoolsResponse {
  total: number;
  pages: number;
  current_page: number;
  page_size: number;
  data: MeteoraPool[];
}

export interface DlmmScreenCandidate {
  pool_address: string;
  pool_name: string;
  token_x_symbol: string;
  token_y_symbol: string;
  tvl: number;
  fee_tvl_ratio_24h: number;
  organic_score: number;
  holders: number;
  mcap: number;
  score: number;
  screened_at: string;
}

export type DlmmPotentialSource =
  | 'signals'
  | 'live'
  | 'board'
  | 'tracker'
  | 'algo-dashboard'
  | 'algo-history'
  | 'dlmm-general';

export interface DlmmPotentialEntry {
  id: string;
  token_address: string;
  token_symbol: string | null;
  source: DlmmPotentialSource;
  notes: string | null;
  added_at: string;
}

export type DlmmRugSource = import('@/types/rug-list').TokenRugSource;

export interface DlmmRugEntry {
  id: string;
  token_address: string;
  token_symbol: string | null;
  source: DlmmRugSource;
  added_at: string;
}

export interface DlmmAgentConfig {
  id: string;
  enabled: boolean;
  dry_run: boolean;
  min_tvl: number;
  min_fee_tvl: number;
  min_organic_score: number;
  min_holders: number;
  take_profit_pct: number;
  stop_loss_pct: number;
  oor_timeout_min: number;
  max_sol_per_position: number;
  max_sol_at_risk: number;
  bin_range_interval: number;
  muted_positions: string[];
  use_llm_reasoner: boolean;
  updated_at: string;
}

export interface DlmmPosition {
  id: string;
  pool_address: string;
  pool_name: string;
  position_pubkey: string | null;
  token_x_symbol: string;
  token_y_symbol: string;
  amount_sol: number;
  min_bin_id: number | null;
  max_bin_id: number | null;
  entry_value_usd: number;
  current_value_usd: number;
  fees_earned_usd: number;
  pnl_pct: number;
  status: DlmmPositionStatus;
  is_muted: boolean;
  oor_since: string | null;
  take_profit_pct: number;
  stop_loss_pct: number;
  oor_timeout_min: number;
  last_decision: DlmmDecision | null;
  last_decision_reason: string | null;
  last_decision_at: string | null;
  tx_signature: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface DlmmLesson {
  id: string;
  position_id: string | null;
  pool_address: string;
  decision: DlmmDecision;
  reason: string;
  pnl_pct: number | null;
  fee_tvl_at_entry: number | null;
  created_at: string;
}

export interface DeployPositionInput {
  poolAddress: string;
  amountSol: number;
  binRangeInterval?: number;
  strategyType?: DlmmStrategyType;
  takeProfitPct?: number;
  stopLossPct?: number;
  oorTimeoutMin?: number;
}

export interface EditPositionInput {
  takeProfitPct?: number;
  stopLossPct?: number;
  oorTimeoutMin?: number;
  binRangeInterval?: number;
  muted?: boolean;
}

export interface DlmmActionResult {
  success: boolean;
  dryRun: boolean;
  positionId?: string;
  positionPubkey?: string;
  minBinId?: number;
  maxBinId?: number;
  signature?: string;
  message: string;
  error?: string;
}

export interface DlmmManageCycleResult {
  success: boolean;
  skipped?: boolean;
  reason?: string;
  decisions: Array<{
    positionId: string;
    poolName: string;
    decision: DlmmDecision;
    reason: string;
    pnlPct: number;
    executed: boolean;
  }>;
  activeCount: number;
  closedCount: number;
}
