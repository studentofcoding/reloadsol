/** Serial rate limiter for Shyft REST API (api.shyft.to). Default 5 req/sec. */

let chain: Promise<void> = Promise.resolve()
let lastAt = 0

function minIntervalMs(): number {
  const maxPerSec = Number(process.env.SHYFT_MAX_REQ_PER_SEC ?? 5)
  if (!Number.isFinite(maxPerSec) || maxPerSec <= 0) {
    return 200
  }
  return Math.ceil(1000 / maxPerSec)
}

export function waitForShyftRateLimit(): Promise<void> {
  chain = chain.then(async () => {
    const gap = minIntervalMs()
    const now = Date.now()
    const wait = Math.max(0, lastAt + gap - now)
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
    lastAt = Date.now()
  })
  return chain
}

export function shyftRateLimitDelayMs(attempt: number): number {
  if (attempt <= 0) return 1000
  if (attempt === 1) return 2000
  return 3000
}
