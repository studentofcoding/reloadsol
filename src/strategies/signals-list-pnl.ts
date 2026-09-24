import { query } from '@/utils/db'
import { isMissingSchemaError } from '@/utils/db-health'
import { signalsListStrategyIds } from '@/utils/signals-strategy-id'
import type { SignalsListPnlRow } from './signals-strategy-list'
import type { StrategyChain, StrategyDomain } from './types'

type PnlAggRow = {
  strategy_id: string
  domain: string
  trade_count: string | number
  avg_pnl_pct: string | number | null
  total_pnl_pct: string | number | null
}

/**
 * Lean sim PnL for the Signals list picker only (not mint membership).
 * COUNT / AVG / SUM — no SELECT *.
 */
export async function aggregateSignalsListPnl(
  chain: StrategyChain,
): Promise<SignalsListPnlRow[]> {
  const strategyIds = [...signalsListStrategyIds(chain)]
  if (strategyIds.length === 0) return []

  try {
    const result = await query<PnlAggRow>(
      `SELECT strategy_id, domain,
              COUNT(*)::int AS trade_count,
              AVG(pnl_pct) FILTER (WHERE pnl_pct IS NOT NULL) AS avg_pnl_pct,
              COALESCE(SUM(pnl_pct) FILTER (WHERE pnl_pct IS NOT NULL), 0) AS total_pnl_pct
       FROM strategy_outcomes
       WHERE chain = $1
         AND is_simulated = true
         AND strategy_id = ANY($2::text[])
       GROUP BY strategy_id, domain`,
      [chain, strategyIds],
    )
    return result.rows.map((row) => ({
      strategy_id: row.strategy_id,
      domain: row.domain as StrategyDomain,
      is_simulated: true,
      trade_count: Number(row.trade_count) || 0,
      avg_pnl_pct: row.avg_pnl_pct == null ? 0 : Number(row.avg_pnl_pct),
      total_pnl_pct: row.total_pnl_pct == null ? 0 : Number(row.total_pnl_pct),
    }))
  } catch (error) {
    if (isMissingSchemaError(error)) return []
    throw error
  }
}
