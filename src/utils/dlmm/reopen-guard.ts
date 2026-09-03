export type ReopenGuardPosition = {
  status: string
  pool_address: string
  closed_at: string | null
}

/**
 * Pools to skip for redeployment: those whose most recent position closed
 * within `cooldownMs`. Prevents the sim-track open→close→reopen loop on the
 * same pool, which would otherwise re-fire a close notification every cycle.
 */
export function poolsBlockedByRecentClose(
  positions: ReopenGuardPosition[],
  cooldownMs: number,
): Set<string> {
  const blocked = new Set<string>()
  const now = Date.now()
  for (const p of positions) {
    if (p.status !== 'closed' || !p.closed_at) continue
    const closedMs = new Date(p.closed_at).getTime()
    if (Number.isFinite(closedMs) && now - closedMs < cooldownMs) {
      blocked.add(p.pool_address)
    }
  }
  return blocked
}

export type OutcomeReopenRow = {
  token_address: string | null
  pool_address: string | null
  exit_at: string | null
  created_at?: string | null
}

/**
 * Durable re-entry guard. Keys off closed `strategy_outcomes` rows (not just the
 * live position table) so a pool/token that keeps resurfacing as a top screener
 * candidate cannot be silently re-opened every cycle. This is what stops the
 * DLMM open → close → reopen churn loop for the same mint.
 */
export function outcomeBlockedKeys(
  rows: OutcomeReopenRow[],
  cooldownMs: number,
  now = Date.now(),
): { tokenKeys: Set<string>; poolKeys: Set<string> } {
  const tokenKeys = new Set<string>()
  const poolKeys = new Set<string>()
  for (const row of rows) {
    const at = row.exit_at ?? row.created_at ?? ''
    if (!at) continue
    const closedMs = new Date(at).getTime()
    if (!Number.isFinite(closedMs) || now - closedMs >= cooldownMs) continue
    if (row.token_address) tokenKeys.add(row.token_address)
    if (row.pool_address) poolKeys.add(row.pool_address)
  }
  return { tokenKeys, poolKeys }
}
