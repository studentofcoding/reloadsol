/** Shared serial rate limiter factory (one in-flight chain per instance). */

export function createSerialRateLimiter(
  envKey: string,
  defaultMaxPerSec = 5,
): {
  wait: () => Promise<void>
  delayMs: (attempt: number) => number
} {
  let chain: Promise<void> = Promise.resolve()
  let lastAt = 0

  function minIntervalMs(): number {
    const maxPerSec = Number(process.env[envKey] ?? defaultMaxPerSec)
    if (!Number.isFinite(maxPerSec) || maxPerSec <= 0) return 200
    return Math.ceil(1000 / maxPerSec)
  }

  return {
    wait() {
      chain = chain.then(async () => {
        const gap = minIntervalMs()
        const now = Date.now()
        const wait = Math.max(0, lastAt + gap - now)
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        lastAt = Date.now()
      })
      return chain
    },
    delayMs(attempt: number) {
      if (attempt <= 0) return 1000
      if (attempt === 1) return 2000
      return 3000
    },
  }
}
