/**
 * Pure re-entry guard for the trending_bot GMGN-feed path.
 *
 * Keys off closed `strategy_outcomes` rows (durable across restarts), the same
 * lesson as utils/dlmm/reopen-guard.ts: a mint that keeps resurfacing as a top
 * trending candidate must not be silently reopened every cycle.
 */

export type TrendingOutcomeRow = {
  strategy_id: string
  token_address: string
  exit_at: string | null
  created_at?: string | null
}

export type TrendingGuardOptions = {
  /** Minutes a (strategy, mint) stays blocked after a close. <= 0 disables. */
  cooldownMinutes: number
  /** Lifetime open cap per (strategy, mint). <= 0 disables. */
  maxPurchasesPerToken: number
  now?: number
}

export function trendingReentryKey(
  strategyId: string,
  tokenAddress: string,
): string {
  return `${strategyId}:${tokenAddress}`
}

/**
 * Keys to skip this cycle. A key is blocked when the mint closed within the
 * cooldown for the same strategy, or when it already hit the lifetime cap.
 */
export function trendingBlockedKeys(
  rows: TrendingOutcomeRow[],
  opts: TrendingGuardOptions,
): Set<string> {
  const now = opts.now ?? Date.now()
  const cooldownMs = Math.max(0, opts.cooldownMinutes) * 60_000
  const cap = opts.maxPurchasesPerToken
  const latestCloseMs = new Map<string, number>()
  const counts = new Map<string, number>()

  for (const row of rows) {
    if (!row.strategy_id || !row.token_address) continue
    const key = trendingReentryKey(row.strategy_id, row.token_address)
    counts.set(key, (counts.get(key) ?? 0) + 1)

    const at = row.exit_at ?? row.created_at ?? ''
    const ms = at ? new Date(at).getTime() : NaN
    if (!Number.isFinite(ms)) continue
    const prev = latestCloseMs.get(key)
    if (prev == null || ms > prev) latestCloseMs.set(key, ms)
  }

  const blocked = new Set<string>()
  if (cooldownMs > 0) {
    for (const [key, ms] of latestCloseMs) {
      if (now - ms < cooldownMs) blocked.add(key)
    }
  }
  if (cap > 0) {
    for (const [key, n] of counts) {
      if (n >= cap) blocked.add(key)
    }
  }
  return blocked
}
