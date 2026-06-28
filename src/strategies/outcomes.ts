import { insertStrategyOutcome } from './db'
import { supabase } from '@/utils/supabase'
import { getAgentConfig } from '@/utils/dlmm/db'
import type { DlmmPosition } from '@/types/dlmm'

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

function mapDlmmPositionRow(row: Record<string, unknown>): DlmmPosition {
  return {
    id: String(row.id),
    pool_address: String(row.pool_address),
    pool_name: String(row.pool_name ?? ''),
    position_pubkey: row.position_pubkey ? String(row.position_pubkey) : null,
    token_x_symbol: String(row.token_x_symbol ?? ''),
    token_y_symbol: String(row.token_y_symbol ?? ''),
    amount_sol: Number(row.amount_sol ?? 0),
    min_bin_id: row.min_bin_id != null ? Number(row.min_bin_id) : null,
    max_bin_id: row.max_bin_id != null ? Number(row.max_bin_id) : null,
    entry_value_usd: Number(row.entry_value_usd ?? 0),
    current_value_usd: Number(row.current_value_usd ?? 0),
    fees_earned_usd: Number(row.fees_earned_usd ?? 0),
    pnl_pct: Number(row.pnl_pct ?? 0),
    status: row.status as DlmmPosition['status'],
    is_muted: Boolean(row.is_muted),
    oor_since: row.oor_since ? String(row.oor_since) : null,
    take_profit_pct: Number(row.take_profit_pct ?? 0),
    stop_loss_pct: Number(row.stop_loss_pct ?? 0),
    oor_timeout_min: Number(row.oor_timeout_min ?? 0),
    last_decision: (row.last_decision as DlmmPosition['last_decision']) ?? null,
    last_decision_reason: row.last_decision_reason
      ? String(row.last_decision_reason)
      : null,
    last_decision_at: row.last_decision_at ? String(row.last_decision_at) : null,
    tx_signature: row.tx_signature ? String(row.tx_signature) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    closed_at: row.closed_at ? String(row.closed_at) : null,
  }
}

async function dlmmOutcomeExistsForPosition(positionId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('strategy_outcomes')
    .select('id')
    .eq('domain', 'dlmm')
    .eq('features->>position_id', positionId)
    .limit(1)
    .maybeSingle()

  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      return false
    }
    console.warn('[strategies/outcomes] dlmm outcome lookup failed:', error.message)
    return false
  }

  return !!data
}

/** Backfill strategy_outcomes rows for closed DLMM positions missing an outcome record. */
export async function syncMissingDlmmOutcomesFromPositions(
  limit = 20,
): Promise<number> {
  const { data, error } = await supabase
    .from('dlmm_positions')
    .select('*')
    .eq('status', 'closed')
    .not('closed_at', 'is', null)
    .order('closed_at', { ascending: false })
    .limit(limit)

  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      return 0
    }
    console.warn('[strategies/outcomes] dlmm backfill query failed:', error.message)
    return 0
  }

  const positions = (data ?? []).map((row) =>
    mapDlmmPositionRow(row as Record<string, unknown>),
  )
  if (positions.length === 0) return 0

  const config = await getAgentConfig()
  let synced = 0

  for (const position of positions) {
    if (await dlmmOutcomeExistsForPosition(position.id)) continue

    await recordDlmmOutcome({
      strategyId: 'dlmm_default',
      poolAddress: position.pool_address,
      entryAt: position.created_at,
      exitAt: position.closed_at ?? new Date().toISOString(),
      pnlPct: position.pnl_pct,
      status: (position.pnl_pct ?? 0) >= 0 ? 'won' : 'lost',
      isSimulated: config.dry_run,
      features: {
        pool_name: position.pool_name,
        position_id: position.id,
        amount_sol: position.amount_sol,
        close_reason: position.last_decision_reason ?? 'backfill_from_closed_position',
        token_symbol:
          position.pool_name ?? position.token_x_symbol ?? position.token_y_symbol,
        initial_price_usd:
          position.entry_value_usd > 0 ? position.entry_value_usd : null,
        exit_price_usd:
          position.current_value_usd > 0 ? position.current_value_usd : null,
        backfilled: true,
      },
    })
    synced++
  }

  if (synced > 0) {
    console.log(`[strategies/outcomes] backfilled ${synced} dlmm outcome(s)`)
  }

  return synced
}
