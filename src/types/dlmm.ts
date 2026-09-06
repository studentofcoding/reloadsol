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
  /** 'sol' (Meteora, default) | 'robinhood' (Pools indexer). */
  chain?: string;
  /** RH only: indexer confidence 0..1 that multiplied the score. */
  confidence?: number | null;
  /** RH only: scoring features (fee efficiency, churn, demand, …). */
  features?: Record<string, unknown> | null;
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
  /** 'sol' (Meteora, default) | 'robinhood' (paper LP). */
  chain?: string;
  /** RH paper LP: entry mark and symmetric range width (%) for in-range / IL. */
  entry_price?: number | null;
  range_pct?: number | null;
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

export type RhUniv2PositionStatus = 'open' | 'closed' | 'pending';

export interface RhUniv2Position {
  id: string;
  pool_address: string;
  pair_label: string | null;
  token_address: string;
  quote_symbol: 'USDG' | 'WETH';
  owner_address: string;
  lp_token_address: string;
  entry_quote_amount: number;
  entry_value_usd: number;
  current_value_usd: number;
  pnl_pct: number;
  status: RhUniv2PositionStatus;
  add_tx: string | null;
  remove_tx: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export type RhClmmPositionStatus = 'open' | 'closed' | 'pending';
export type RhClmmProtocol = 'v3' | 'v4';

/** JSON-safe v4 PoolKey persisted in the RH CLMM ledger at mint time. */
export type RhV4PoolKeyJson = {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
};

export interface RhClmmPosition {
  id: string;
  token_id: string;
  protocol: RhClmmProtocol;
  pool_address: string;
  pair_label: string | null;
  token_address: string | null;
  deposit_symbol: string | null;
  owner_address: string;
  entry_value_usd: number;
  current_value_usd: number;
  pnl_pct: number;
  status: RhClmmPositionStatus;
  mint_tx: string | null;
  close_tx: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /** Live snapshot (Redis hot / DB cold) */
  unclaimed_fees_usd?: number;
  in_range?: boolean | null;
  tick_lower?: number | null;
  tick_upper?: number | null;
  symbol0?: string | null;
  symbol1?: string | null;
  liquidity?: string | null;
  live_synced_at?: string | null;
  /** v4 pool identity recorded at mint (rec 3.3) — skips fee/spacing brute-force */
  pool_id?: string | null;
  pool_key?: RhV4PoolKeyJson | null;
  fee?: number | null;
  tick_spacing?: number | null;
}

/** JSON-safe CLMM live row for Redis + /api/dlmm/rh-clmm-live */
export type RhClmmLiveRow = {
  tokenId: string;
  protocol: RhClmmProtocol;
  poolAddress: string;
  pairLabel: string;
  symbol0: string;
  symbol1: string;
  decimals0: number;
  decimals1: number;
  valueUsd: number;
  unclaimedFeesUsd: number;
  inRange: boolean;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  tokensOwed0: string;
  tokensOwed1: string;
  token0: string;
  token1: string;
  entryValueUsd?: number;
  pnlPct?: number | null;
  createdAt?: string | null;
  markId?: string | null;
};
