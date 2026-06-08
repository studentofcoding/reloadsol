import type { DlmmAgentConfig } from '@/types/dlmm';

function parseFloatEnv(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseIntEnv(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseBoolEnv(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

export const DLMM_CONFIG = {
  agentEnabled: parseBoolEnv('DLMM_AGENT_ENABLED', false),
  dryRun: parseBoolEnv('DLMM_DRY_RUN', true),
  screenSecret:
    process.env.DLMM_SCREEN_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    'r3l0ads0l-trending',
  manageSecret:
    process.env.DLMM_MANAGE_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    'r3l0ads0l-trending',
  apiPassword: process.env.DLMM_API_PASSWORD || 'earlytrencher',
  meteoraApiBase: 'https://dlmm.datapi.meteora.ag',
  screenIntervalMs: parseIntEnv('DLMM_SCREEN_INTERVAL_MS', 5 * 60 * 1000),
  manageIntervalMs: parseIntEnv('DLMM_MANAGE_INTERVAL_MS', 60 * 1000),
  minTvl: parseFloatEnv('DLMM_MIN_TVL', 50_000),
  minFeeTvl: parseFloatEnv('DLMM_MIN_FEE_TVL', 0.1),
  minOrganicScore: parseFloatEnv('DLMM_MIN_ORGANIC_SCORE', 50),
  minHolders: parseIntEnv('DLMM_MIN_HOLDERS', 100),
  takeProfitPct: parseFloatEnv('DLMM_TAKE_PROFIT_PCT', 5),
  stopLossPct: parseFloatEnv('DLMM_STOP_LOSS_PCT', -10),
  oorTimeoutMin: parseIntEnv('DLMM_OOR_TIMEOUT_MIN', 16),
  maxSolPerPosition: parseFloatEnv('DLMM_MAX_SOL_PER_POSITION', 1),
  maxSolAtRisk: parseFloatEnv('DLMM_MAX_SOL_AT_RISK', parseFloatEnv('MAX_SOL_AT_RISK', 5)),
  binRangeInterval: parseIntEnv('DLMM_BIN_RANGE_INTERVAL', 10),
  useLlmReasoner: parseBoolEnv('DLMM_USE_LLM_REASONER', false),
  poolsCacheTtlMs: parseIntEnv('DLMM_POOLS_CACHE_TTL_MS', 5 * 60 * 1000),
};

export function defaultAgentConfig(): Omit<DlmmAgentConfig, 'id' | 'updated_at'> {
  return {
    enabled: DLMM_CONFIG.agentEnabled,
    dry_run: DLMM_CONFIG.dryRun,
    min_tvl: DLMM_CONFIG.minTvl,
    min_fee_tvl: DLMM_CONFIG.minFeeTvl,
    min_organic_score: DLMM_CONFIG.minOrganicScore,
    min_holders: DLMM_CONFIG.minHolders,
    take_profit_pct: DLMM_CONFIG.takeProfitPct,
    stop_loss_pct: DLMM_CONFIG.stopLossPct,
    oor_timeout_min: DLMM_CONFIG.oorTimeoutMin,
    max_sol_per_position: DLMM_CONFIG.maxSolPerPosition,
    max_sol_at_risk: DLMM_CONFIG.maxSolAtRisk,
    bin_range_interval: DLMM_CONFIG.binRangeInterval,
    muted_positions: [],
    use_llm_reasoner: DLMM_CONFIG.useLlmReasoner,
  };
}

export function isAuthorizedRequest(
  secret?: string | null,
  expected = DLMM_CONFIG.manageSecret,
): boolean {
  return !!secret && secret === expected;
}

export function isDlmmApiAuthorized(password?: string | null): boolean {
  return !!password && password === DLMM_CONFIG.apiPassword;
}
