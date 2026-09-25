import { insertStrategyOutcome } from './db'
import { query, queryOne } from '@/utils/db'
import { isMissingSchemaError } from '@/utils/db-health'
import { getAgentConfig } from '@/utils/dlmm/db'
import { coerceIsoTimestamp } from '@/utils/datetime'
import type { DlmmPosition } from '@/types/dlmm'
import { notifyStrategyClose } from './strategy-telegram-notify'
import { closeOutcomeStatusFromPnl } from './close-outcome-status'
import type { StrategyChain } from './types'

export async function recordTrendingBotOutcome(params: {
  strategyId: string
  tokenAddress: string
  chain?: StrategyChain
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
    chain: params.chain ?? 'sol',
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
  chain?: StrategyChain
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
    chain: params.chain ?? 'sol',
    token_address: params.tokenAddress,
    entry_at: params.entryAt ?? null,
    exit_at: params.exitAt ?? new Date().toISOString(),
    pnl_pct: params.pnlPct ?? null,
    status: params.status ?? null,
    is_simulated: params.isSimulated ?? true,
    features: params.features ?? null,
  })

  if (params.pnlPct != null) {
    notifyStrategyClose({
      domain: 'signals',
      strategyId: params.strategyId,
      tokenAddress: params.tokenAddress,
      pnlPct: params.pnlPct,
      status: params.status,
      isSimulated: params.isSimulated ?? true,
      features: params.features,
    })
  }
}

export async function recordDlmmOutcome(params: {
  strategyId?: string
  poolAddress: string
  /** Token mint when known; falls back to poolAddress for legacy rows */
  mintAddress?: string | null
  entryAt?: string | null
  exitAt?: string | null
  pnlPct?: number | null
  status?: string | null
  isSimulated?: boolean
  features?: Record<string, unknown> | null
}): Promise<boolean> {
  const mint = params.mintAddress?.trim() || null
  const features: Record<string, unknown> = {
    ...(params.features ?? {}),
    instrument: 'dlmm_lp',
    pool_address: params.poolAddress,
    mint_address: mint,
  }
  if (typeof features.pool_volume === 'number') {
    const domainBag =
      features.domain_features && typeof features.domain_features === 'object'
        ? { ...(features.domain_features as Record<string, unknown>) }
        : {}
    domainBag.dlmm = {
      ...(typeof domainBag.dlmm === 'object' && domainBag.dlmm
        ? (domainBag.dlmm as Record<string, unknown>)
        : {}),
      pool_volume_24h: features.pool_volume,
      fee_tvl_ratio_24h: features.fee_tvl_ratio_24h ?? null,
    }
    features.domain_features = domainBag
  }

  const inserted = await insertStrategyOutcome({
    strategy_id: params.strategyId ?? 'dlmm_default',
    domain: 'dlmm',
    // Prefer mint for token-centric spine; keep pool in features.pool_address
    token_address: mint || params.poolAddress,
    entry_at: params.entryAt ?? null,
    exit_at: params.exitAt ?? new Date().toISOString(),
    pnl_pct: params.pnlPct ?? null,
    status: params.status ?? null,
    is_simulated: params.isSimulated ?? true,
    features,
  })

  if (inserted && params.pnlPct != null) {
    notifyStrategyClose({
      domain: 'dlmm',
      strategyId: params.strategyId ?? 'dlmm_default',
      tokenAddress: mint || params.poolAddress,
      pnlPct: params.pnlPct,
      status: params.status,
      isSimulated: params.isSimulated ?? true,
      features,
    })
  }
  return inserted
}

export async function recordMcapTrackerOutcome(params: {
  strategyId: string
  tokenAddress: string
  chain?: StrategyChain
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
    chain: params.chain ?? 'sol',
    token_address: params.tokenAddress,
    entry_at: params.entryAt ?? null,
    exit_at: params.exitAt ?? new Date().toISOString(),
    pnl_pct: params.pnlPct ?? null,
    status: params.status ?? null,
    is_simulated: params.isSimulated ?? true,
    features: params.features ?? null,
  })

  if (params.pnlPct != null) {
    notifyStrategyClose({
      domain: 'mcap_tracker',
      strategyId: params.strategyId,
      tokenAddress: params.tokenAddress,
      pnlPct: params.pnlPct,
      status: params.status,
      isSimulated: params.isSimulated ?? true,
      features: params.features,
    })
  }
}

export async function recordGmgnOutcome(params: {
  strategyId: string
  tokenAddress: string
  chain?: StrategyChain
  entryAt?: string | null
  exitAt?: string | null
  pnlPct?: number | null
  status?: string | null
  isSimulated?: boolean
  features?: Record<string, unknown> | null
}): Promise<void> {
  await insertStrategyOutcome({
    strategy_id: params.strategyId,
    domain: 'gmgn',
    chain: params.chain ?? 'sol',
    token_address: params.tokenAddress,
    entry_at: params.entryAt ?? null,
    exit_at: params.exitAt ?? new Date().toISOString(),
    pnl_pct: params.pnlPct ?? null,
    status: params.status ?? null,
    is_simulated: params.isSimulated ?? true,
    features: params.features ?? null,
  })

  if (params.pnlPct != null) {
    notifyStrategyClose({
      domain: 'gmgn',
      strategyId: params.strategyId,
      tokenAddress: params.tokenAddress,
      pnlPct: params.pnlPct,
      status: params.status,
      isSimulated: params.isSimulated ?? true,
      features: params.features,
    })
  }
}

export async function recordSocialOutcome(params: {
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
    domain: 'social',
    token_address: params.tokenAddress,
    entry_at: params.entryAt ?? null,
    exit_at: params.exitAt ?? new Date().toISOString(),
    pnl_pct: params.pnlPct ?? null,
    status: params.status ?? null,
    is_simulated: params.isSimulated ?? true,
    features: params.features ?? null,
  })

  if (params.pnlPct != null) {
    notifyStrategyClose({
      domain: 'social',
      strategyId: params.strategyId,
      tokenAddress: params.tokenAddress,
      pnlPct: params.pnlPct,
      status: params.status,
      isSimulated: params.isSimulated ?? true,
      features: params.features,
    })
  }
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
    oor_since: coerceIsoTimestamp(row.oor_since),
    take_profit_pct: Number(row.take_profit_pct ?? 0),
    stop_loss_pct: Number(row.stop_loss_pct ?? 0),
    oor_timeout_min: Number(row.oor_timeout_min ?? 0),
    last_decision: (row.last_decision as DlmmPosition['last_decision']) ?? null,
    last_decision_reason: row.last_decision_reason
      ? String(row.last_decision_reason)
      : null,
    last_decision_at: coerceIsoTimestamp(row.last_decision_at),
    tx_signature: row.tx_signature ? String(row.tx_signature) : null,
    created_at: coerceIsoTimestamp(row.created_at) ?? '',
    updated_at: coerceIsoTimestamp(row.updated_at) ?? '',
    closed_at: coerceIsoTimestamp(row.closed_at),
  }
}

async function dlmmOutcomeExistsForPosition(positionId: string): Promise<boolean> {
  try {
    const row = await queryOne<{ id: string }>(
      `SELECT id FROM strategy_outcomes
       WHERE domain = 'dlmm'
         AND features->>'position_id' = $1
       LIMIT 1`,
      [positionId],
    )
    return !!row
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return false
    }
    console.warn(
      '[strategies/outcomes] dlmm outcome lookup failed:',
      error instanceof Error ? error.message : error,
    )
    return false
  }
}

/**
 * Load recently-closed DLMM outcomes (within `cooldownMs`) so the sim-track can
 * refuse to re-open a pool/token it has already closed on. Durable across
 * position instances and restarts, unlike the transient position-table guard.
 */
export async function loadRecentlyClosedDlmmOutcomes(
  cooldownMs: number,
): Promise<import('@/utils/dlmm/reopen-guard').OutcomeReopenRow[]> {
  const cutoff = new Date(Date.now() - cooldownMs).toISOString()
  try {
    const { rows } = await query<{
      token_address: string | null
      pool_address: string | null
      exit_at: string | null
      created_at: string | null
    }>(
      `SELECT token_address,
              features->>'pool_address' AS pool_address,
              exit_at,
              created_at
       FROM strategy_outcomes
       WHERE domain = 'dlmm'
         AND COALESCE(exit_at, created_at) >= $1
       ORDER BY created_at DESC
       LIMIT 500`,
      [cutoff],
    )
    return rows.map((r) => ({
      token_address: r.token_address,
      pool_address: r.pool_address || null,
      exit_at: r.exit_at,
      created_at: r.created_at,
    }))
  } catch (error) {
    if (isMissingSchemaError(error)) return []
    console.warn(
      '[strategies/outcomes] recent dlmm outcome lookup failed:',
      error instanceof Error ? error.message : error,
    )
    return []
  }
}

/**
 * Closed outcomes for the re-entry guard.
 *
 * The load window is derived from the cooldown and filtered in SQL, rather than relying
 * on a bare `LIMIT` against `created_at`. With 76k+ rows a plain limit only covered the
 * last ~31h, so at high churn a still-cooling mint could fall out of the set and be
 * reopened. The window is floored at 24h so the lifetime-cap counts keep the same
 * effective horizon they had under the old limit.
 *
 * Ordered by the same timestamp the guard reads: `exit_at`, falling back to `created_at`.
 */
export async function loadClosedTrendingOutcomes(
  chain: StrategyChain,
  cooldownMinutes = 1440,
  limit = 2000,
): Promise<import('@/utils/trending-reopen-guard').TrendingOutcomeRow[]> {
  const windowMinutes = Math.max(1, Math.max(cooldownMinutes, 1440))
  try {
    const { rows } = await query<{
      strategy_id: string
      token_address: string
      exit_at: string | null
      created_at: string | null
    }>(
      `SELECT strategy_id, token_address, exit_at, created_at
       FROM strategy_outcomes
       WHERE domain = 'trending_bot'
         AND chain = $1
         AND COALESCE(exit_at, created_at) > NOW() - make_interval(mins => $2::int)
       ORDER BY COALESCE(exit_at, created_at) DESC
       LIMIT $3`,
      [chain, windowMinutes, limit],
    )
    return rows.map((r) => ({
      strategy_id: r.strategy_id,
      token_address: r.token_address,
      exit_at: r.exit_at,
      created_at: r.created_at,
    }))
  } catch (error) {
    if (isMissingSchemaError(error)) return []
    console.warn(
      '[strategies/outcomes] closed trending outcome lookup failed:',
      error instanceof Error ? error.message : error,
    )
    return []
  }
}

/** Closed positions whose outcome insert failed after timestamp coerce. Skip until process restart. */
const dlmmOutcomeSyncSkipIds = new Set<string>()

export function resetDlmmOutcomeSyncSkips(): void {
  dlmmOutcomeSyncSkipIds.clear()
}

function markDlmmOutcomeSyncSkipped(positionId: string, reason: string): void {
  if (dlmmOutcomeSyncSkipIds.has(positionId)) return
  dlmmOutcomeSyncSkipIds.add(positionId)
  console.warn(
    `[strategies/outcomes] skip dlmm outcome sync ${positionId}: ${reason}`,
  )
}

export async function syncMissingDlmmOutcomesFromPositions(
  limit = 20,
): Promise<number> {
  let rows: Record<string, unknown>[]
  const skipIds = [...dlmmOutcomeSyncSkipIds]
  try {
    const result = skipIds.length
      ? await query<Record<string, unknown>>(
          `SELECT * FROM dlmm_positions
           WHERE status = 'closed'
             AND closed_at IS NOT NULL
             AND NOT (id = ANY($2::uuid[]))
           ORDER BY closed_at DESC
           LIMIT $1`,
          [limit, skipIds],
        )
      : await query<Record<string, unknown>>(
          `SELECT * FROM dlmm_positions
           WHERE status = 'closed'
             AND closed_at IS NOT NULL
           ORDER BY closed_at DESC
           LIMIT $1`,
          [limit],
        )
    rows = result.rows
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return 0
    }
    console.warn(
      '[strategies/outcomes] dlmm backfill query failed:',
      error instanceof Error ? error.message : error,
    )
    return 0
  }

  const positions = rows.map((row) => mapDlmmPositionRow(row))
  if (positions.length === 0) return 0

  const config = await getAgentConfig()
  let synced = 0

  const { fetchMeteoraPool } = await import('@/utils/meteora')
  const { resolveDlmmMintFromPoolTokens } = await import('./canonical-features')

  for (const position of positions) {
    if (dlmmOutcomeSyncSkipIds.has(position.id)) continue
    if (await dlmmOutcomeExistsForPosition(position.id)) continue

    const entryAt = coerceIsoTimestamp(position.created_at)
    const exitAt = coerceIsoTimestamp(position.closed_at)
    if (!exitAt) {
      markDlmmOutcomeSyncSkipped(position.id, 'unparseable closed_at')
      continue
    }

    let mintAddress: string | null = null
    try {
      const pool = await fetchMeteoraPool(position.pool_address)
      mintAddress = resolveDlmmMintFromPoolTokens(pool.token_x, pool.token_y)
    } catch {
      /* mint optional on backfill */
    }

    const inserted = await recordDlmmOutcome({
      strategyId: 'dlmm_default',
      poolAddress: position.pool_address,
      mintAddress,
      entryAt,
      exitAt,
      pnlPct: position.pnl_pct,
      status: closeOutcomeStatusFromPnl(position.pnl_pct ?? 0),
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
        ml_skipped: mintAddress ? undefined : 'incomplete_token_features',
      },
    })
    if (!inserted) {
      markDlmmOutcomeSyncSkipped(position.id, 'insert failed after timestamp coerce')
      continue
    }
    synced++
  }

  if (synced > 0) {
    console.log(`[strategies/outcomes] backfilled ${synced} dlmm outcome(s)`)
  }

  return synced
}
