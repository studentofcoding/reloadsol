/**
 * Short-lived cache for `fetchTradingRecordsForWallet` (src/strategies/db.ts).
 *
 * Not to be confused with `trading-records-cache.ts`, which caches the `GET /api/trading/records`
 * HTTP response. This one backs the internal reader that reconstructs open cycles.
 *
 * Why it exists: that read hydrates a whole wallet. `mcap-tracker-sim` is 6,302 rows / 11 MB and
 * costs ~7.8s of client-side parsing, and the pool client is held for the whole of it. Callers ask
 * for the same wallet repeatedly within one pass — the mcap sim-track route reads it once per
 * strategy on a 15s open-phase cadence, and the SL/TP worker's close path reads it per position.
 * Measured on prod: 25 reads/min of the mcap wallet saturated a 25-client pool
 * (`total=25 idle=0 waiting=5…8`, 113 acquire failures in 10 minutes) and left the SL/TP monitor
 * completing 1 pass in 8.
 *
 * Nothing about the returned value changes — same read, just not repeated. Two properties make it
 * safe:
 *
 *  1. TTL. The same behaviour `loadMcapSimRecords` already uses for this exact read (60s there).
 *  2. Invalidation on write. Every writer of `trading_records` clears the affected wallet, so a
 *     caller that re-reads immediately after writing — the sim-track routes' open gate, which
 *     exists precisely to see post-close state — still sees it.
 *
 * Bounded TTL, so a caller that never writes still cannot see arbitrarily old data.
 *
 * Deliberately a separate module: the reader is in `strategies/db.ts` and the writers in
 * `utils/trading-records-db.ts`, so a shared home avoids an import cycle between them.
 */

type Entry = { at: number; value: unknown[] }

const TTL_MS = Number.parseInt(process.env.WALLET_RECORDS_CACHE_MS || '60000', 10)

const cache = new Map<string, Entry>()

export const WALLET_RECORDS_CACHE_TTL_MS = TTL_MS

export function walletRecordsCacheKey(wallet: string, opts?: unknown): string {
  return `${wallet}\u0000${opts ? JSON.stringify(opts) : ''}`
}

/** Cached rows for a key, or null when absent, expired, or caching is disabled. */
export function readWalletRecordsCache<T>(key: string): T[] | null {
  if (!(TTL_MS > 0)) return null
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at >= TTL_MS) {
    cache.delete(key)
    return null
  }
  return hit.value as T[]
}

export function writeWalletRecordsCache(key: string, value: unknown[]): void {
  if (!(TTL_MS > 0)) return
  cache.set(key, { at: Date.now(), value })
}

/** Drop every cached read of a wallet. Called by every writer of `trading_records`. */
export function invalidateWalletRecordsCache(wallet?: string): void {
  if (!wallet) {
    cache.clear()
    return
  }
  const prefix = `${wallet}\u0000`
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}

/** Test seam. */
export function resetWalletRecordsCacheForTests(): void {
  cache.clear()
}
