/**
 * Process-wide spacing for Solana Tracker OHLC HTTP starts.
 * Backfill workers and live `fetchTokenOhlcUpstream` share this queue so
 * parallel concurrency cannot burst past the host limit.
 *
 * Default 3 starts/second (`SOLANATRACKER_OHLC_RPS`). Capacity is one token:
 * the next start is at least `1000/rps` ms after the previous reservation.
 * A full bucket of N would still burst N calls at t=0.
 */

export const DEFAULT_SOLANATRACKER_OHLC_RPS = 3

export function solanaTrackerOhlcRps(): number {
  const raw = Number(process.env.SOLANATRACKER_OHLC_RPS)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SOLANATRACKER_OHLC_RPS
  return raw
}

let tail: Promise<void> = Promise.resolve()
let nextAtMs = 0

/** Test hook. Production callers share one queue for the life of the process. */
export function resetSolanaTrackerOhlcLimiterForTests(): void {
  tail = Promise.resolve()
  nextAtMs = 0
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Wait until this process may start another Solana Tracker OHLC request. */
export function acquireSolanaTrackerOhlcSlot(): Promise<void> {
  const intervalMs = 1000 / solanaTrackerOhlcRps()
  const turn = tail.then(async () => {
    const now = Date.now()
    const start = Math.max(now, nextAtMs)
    nextAtMs = start + intervalMs
    await sleep(Math.max(0, Math.ceil(start - now)))
  })
  tail = turn.then(
    () => undefined,
    () => undefined,
  )
  return turn
}
