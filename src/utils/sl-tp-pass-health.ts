/**
 * Health verdict for one SL/TP monitor pass.
 *
 * Why it exists: `getCurrentTokenPrices` used to swallow every error and return an empty map, so a
 * price outage (Jupiter/GMGN down, Redis down, a thrown fetch) made EVERY position "stale" — and the
 * pass still returned 200, the Go worker recorded a success, and the freshness watchdog (which reads
 * `cron_worker_runtime.last_success_at`) saw a healthy closer while nothing could exit. A pass that
 * could not price its book is not a success.
 *
 * Pure: no I/O, so the decision is testable and the thrower stays a thin wrapper.
 */

export const DEFAULT_STALE_ALERT_RATIO = 0.5
export const DEFAULT_STALE_ALERT_MIN_POSITIONS = 5

export type SltpPassHealth = {
  ok: boolean
  reason: string | null
  staleRatio: number
}

function numEnv(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * Unhealthy when (a) a price fetch threw for any chain, or (b) at least `SLTP_STALE_ALERT_MIN_POSITIONS`
 * (default 5) positions were in the pass and `SLTP_STALE_ALERT_RATIO` (default 0.5) or more of them
 * had no price. The ratio check is off when the ratio is 0; fetch failures always count.
 */
export function evaluateSltpPassHealth(
  input: { positions: number; stale: number; failedChains: string[] },
  env: Record<string, string | undefined> = process.env,
): SltpPassHealth {
  const staleRatio = input.positions > 0 ? input.stale / input.positions : 0
  if (input.failedChains.length > 0) {
    return {
      ok: false,
      reason: `price fetch failed for chain(s) ${input.failedChains.join(', ')} (${input.stale}/${input.positions} positions unpriced)`,
      staleRatio,
    }
  }
  const ratio = numEnv(env, 'SLTP_STALE_ALERT_RATIO', DEFAULT_STALE_ALERT_RATIO)
  const min = numEnv(env, 'SLTP_STALE_ALERT_MIN_POSITIONS', DEFAULT_STALE_ALERT_MIN_POSITIONS)
  if (ratio > 0 && input.positions >= min && staleRatio >= ratio) {
    return {
      ok: false,
      reason: `${input.stale}/${input.positions} positions unpriced (${(staleRatio * 100).toFixed(0)}% >= ${(ratio * 100).toFixed(0)}%)`,
      staleRatio,
    }
  }
  return { ok: true, reason: null, staleRatio }
}

/** Thrown AFTER the pass finished its work, so the route answers 500 and the worker records a failure. */
export class SltpPassUnhealthyError extends Error {
  readonly staleRatio: number
  constructor(reason: string, staleRatio: number) {
    super(`SL/TP pass unhealthy: ${reason}`)
    this.name = 'SltpPassUnhealthyError'
    this.staleRatio = staleRatio
  }
}
