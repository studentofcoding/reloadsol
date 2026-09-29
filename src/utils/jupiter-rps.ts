/**
 * Target request rate for Jupiter, env-tunable (`JUPITER_MAX_RPS`, default 0.5).
 *
 * Measured on prod with the account key, while the app's own traffic shared it:
 *
 *   paced  0.5 rps — 10/10 ok, p50 260ms p95 388ms
 *   paced  0.4 rps — 10/10 ok
 *   paced  0.3 rps — 10/10 ok
 *   burst  ~6 rps sequential — 8 ok then 429s
 *   conc   4 / 8 / 12 — **0 ok, 100% 429**, rejected in 11-40ms
 *
 * So the quota is ~0.5 rps and the shape matters more than the number: spaced single requests are
 * clean at the quota, while ANY concurrency is rejected outright. The default is therefore the
 * measured-clean rate rather than a hopeful one — a missing env var must not reintroduce bursts —
 * and any concurrent fan-out to Jupiter is a bug, not a tuning problem.
 */
export function resolveJupiterMaxRps(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.JUPITER_MAX_RPS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.5
}

export const JUPITER_MAX_RPS = resolveJupiterMaxRps()
export const JUPITER_USER_AGENT = 'BuyBulk/1.0'

const MIN_INTERVAL_MS = 1000 / JUPITER_MAX_RPS
let nextSlotMs = 0

export function resetJupiterRpsForTests(): void {
  nextSlotMs = 0
}

export async function throttleJupiterRps(): Promise<void> {
  const now = Date.now()
  const slot = Math.max(now, nextSlotMs)
  nextSlotMs = slot + MIN_INTERVAL_MS
  const wait = slot - now
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
}

export function jupiterApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'cache-control': 'no-cache',
    'user-agent': JUPITER_USER_AGENT,
  }
  const key = process.env.JUPITER_API_KEY?.trim()
  if (key) headers['x-api-key'] = key
  return headers
}
