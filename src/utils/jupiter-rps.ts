/**
 * Target request rate for Jupiter, env-tunable (`JUPITER_MAX_RPS`, default 5).
 *
 * Measured on prod with the account key: 15 sequential order requests gave **8 OK then 429s**
 * (p50 259ms), and concurrency 4/8/12 gave **0 OK — 100% 429**, rejected in 11–40ms. So the quota
 * behaves like a small burst bucket, not a smooth per-second allowance: the only safe shape is
 * spaced-out single requests. Keep this cap low, and treat any concurrent fan-out to Jupiter as a
 * bug rather than a tuning problem.
 */
function resolveJupiterMaxRps(): number {
  const parsed = Number(process.env.JUPITER_MAX_RPS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5
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
