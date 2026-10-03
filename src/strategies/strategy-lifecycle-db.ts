/**
 * The one read the strategy lifecycle needs: the latest closed outcome per strategy id.
 * Read-only aggregate over `strategy_outcomes` (indexed on `strategy_id`); no writes.
 */
import { query } from '@/utils/db'
import { outcomeCountsAsTradeSql } from '@/strategies/outcome-exclusions'

const TTL_MS = 60_000
let cache: { at: number; value: Record<string, string> } | null = null

export function resetLastOutcomeCacheForTests(): void {
  cache = null
}

export async function getLastClosedOutcomeAtByStrategy(
  now: number = Date.now(),
): Promise<Record<string, string>> {
  if (cache && now - cache.at < TTL_MS) return cache.value
  const { rows } = await query<{ strategy_id: string; last_exit_at: Date | string | null }>(
    `SELECT strategy_id, MAX(exit_at) AS last_exit_at
       FROM strategy_outcomes
      WHERE strategy_id IS NOT NULL AND exit_at IS NOT NULL
        AND ${outcomeCountsAsTradeSql()}
      GROUP BY strategy_id`,
  )
  const value: Record<string, string> = {}
  for (const row of rows) {
    if (!row.last_exit_at) continue
    const iso = row.last_exit_at instanceof Date ? row.last_exit_at.toISOString() : String(row.last_exit_at)
    value[row.strategy_id] = iso
  }
  cache = { at: now, value }
  return value
}
