import { insertStrategyOutcome } from './db'

export async function recordTrendingBotOutcome(params: {
  strategyId: string
  tokenAddress: string
  entryAt?: string | null
  exitAt?: string | null
  pnlPct?: number | null
  status?: string | null
  isSimulated?: boolean
  features?: Record<string, unknown> | null
}): Promise<void> {
  await insertStrategyOutcome({
    strategy_id: params.strategyId,
    domain: 'trending_bot',
    token_address: params.tokenAddress,
    entry_at: params.entryAt ?? null,
    exit_at: params.exitAt ?? new Date().toISOString(),
    pnl_pct: params.pnlPct ?? null,
    status: params.status ?? null,
    is_simulated: params.isSimulated ?? true,
    features: params.features ?? null,
  })
}

export async function recordSignalsOutcome(params: {
  strategyId: string
  tokenAddress: string
  entryAt?: string | null
  exitAt?: string | null
  pnlPct?: number | null
  status?: string | null
  isSimulated?: boolean
  features?: Record<string, unknown> | null
}): Promise<void> {
  await insertStrategyOutcome({
    strategy_id: params.strategyId,
    domain: 'signals',
    token_address: params.tokenAddress,
    entry_at: params.entryAt ?? null,
    exit_at: params.exitAt ?? new Date().toISOString(),
    pnl_pct: params.pnlPct ?? null,
    status: params.status ?? null,
    is_simulated: params.isSimulated ?? true,
    features: params.features ?? null,
  })
}

export async function recordDlmmOutcome(params: {
  strategyId?: string
  poolAddress: string
  entryAt?: string | null
  exitAt?: string | null
  pnlPct?: number | null
  status?: string | null
  isSimulated?: boolean
  features?: Record<string, unknown> | null
}): Promise<void> {
  await insertStrategyOutcome({
    strategy_id: params.strategyId ?? 'dlmm_default',
    domain: 'dlmm',
    token_address: params.poolAddress,
    entry_at: params.entryAt ?? null,
    exit_at: params.exitAt ?? new Date().toISOString(),
    pnl_pct: params.pnlPct ?? null,
    status: params.status ?? null,
    is_simulated: params.isSimulated ?? true,
    features: params.features ?? null,
  })
}

export async function recordMcapTrackerOutcome(params: {
  strategyId: string
  tokenAddress: string
  entryAt?: string | null
  exitAt?: string | null
  pnlPct?: number | null
  status?: string | null
  isSimulated?: boolean
  features?: Record<string, unknown> | null
}): Promise<void> {
  await insertStrategyOutcome({
    strategy_id: params.strategyId,
    domain: 'mcap_tracker',
    token_address: params.tokenAddress,
    entry_at: params.entryAt ?? null,
    exit_at: params.exitAt ?? new Date().toISOString(),
    pnl_pct: params.pnlPct ?? null,
    status: params.status ?? null,
    is_simulated: params.isSimulated ?? true,
    features: params.features ?? null,
  })
}
