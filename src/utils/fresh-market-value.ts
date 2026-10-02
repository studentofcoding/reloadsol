/**
 * A market value observed NOW, or nothing.
 *
 * Why this exists: `token_mcap_tracking` is the source every mcap card and entry reads, and it is
 * stale by construction. `trackTokenMcap` only writes on a >1% change or a 600s heartbeat, and its
 * only timed callers are two 2-minute crons. Measured on prod, among the tokens the mcap sim
 * actually considers (chain sol, updated within 240 min, inside the 30k–2M band):
 *
 *   candidates 201 | median row age 23.2 min | p90 3.2 h | worst 4.0 h
 *   within 5 seconds: 0        within 3 minutes: 21 (10%)
 *
 * `resolveMcapSimEntry` says "always book live current_mcap at open time" and then returns
 * `snapshot.current_mcap` — a row that may be hours old. Prod 2026-10-02: a token that crossed its
 * 80% milestone at 13:20 was opened at 16:13 against a frozen $307.2K row and closed 4 minutes
 * later at $171K, −44.2%.
 *
 * The live source already existed and was already being called on that path — `fetchJupiterMarketHints`
 * returns `mcap`, the radar cards use it, and `resolveTokenMonitorSnapshot` computed it and kept only
 * `usdPrice`/`volume5m`. Probed across 20 live candidates: **100% returned an mcap, 0 errors, p50
 * 38 ms / p90 43 ms**, and every value agreed with the tracked row within ~1–5% (every one of those
 * rows was exactly 102s old). So this is a small substitution, not a change of basis — and because a
 * successful read is fresh by construction, callers need no separate age threshold: a null here
 * means skip.
 *
 * Deliberately no long-lived fallback. A stale answer is the bug; serving one because the live read
 * failed would reintroduce it under a new name.
 */

import { fetchJupiterMarketHints } from '@/utils/jupiter-metadata'

export type FreshMarketValue = {
  value: number
  /** ms epoch of the observation (≈ the read time). */
  observedAtMs: number
  observedAtIso: string
  source: 'jupiter-v2-search'
}

const CACHE_MS = Number.parseInt(process.env.NOTIFY_FRESH_CACHE_MS || '5000', 10)

const cache = new Map<string, FreshMarketValue>()

/** In-flight de-duplication: several strategies read the same mint in one pass. */
const inflight = new Map<string, Promise<FreshMarketValue | null>>()

function key(mint: string): string {
  return mint
}

async function read(mint: string): Promise<FreshMarketValue | null> {
  try {
    const hints = await fetchJupiterMarketHints(mint)
    const mcap = hints?.mcap
    if (typeof mcap !== 'number' || !Number.isFinite(mcap) || mcap <= 0) return null
    const now = Date.now()
    return {
      value: mcap,
      observedAtMs: now,
      observedAtIso: new Date(now).toISOString(),
      source: 'jupiter-v2-search',
    }
  } catch {
    return null
  }
}

/**
 * Live market cap for a mint, or null when it cannot be observed right now.
 * Cached for `NOTIFY_FRESH_CACHE_MS` (default 5s) and de-duplicated in flight.
 */
export async function resolveFreshMarketValue(
  mint: string,
): Promise<FreshMarketValue | null> {
  if (!mint) return null

  if (CACHE_MS > 0) {
    const hit = cache.get(key(mint))
    if (hit && Date.now() - hit.observedAtMs < CACHE_MS) return hit
  }

  const pending = inflight.get(key(mint))
  if (pending) return pending

  const promise = read(mint).finally(() => {
    inflight.delete(key(mint))
  })
  inflight.set(key(mint), promise)

  const result = await promise
  if (result && CACHE_MS > 0) cache.set(key(mint), result)
  return result
}

/** Test seam. */
export function resetFreshMarketValueForTests(): void {
  cache.clear()
  inflight.clear()
}
