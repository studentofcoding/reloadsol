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