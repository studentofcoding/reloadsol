import { createSerialRateLimiter } from '@/utils/serial-rate-limit'

const limiter = createSerialRateLimiter('SHYFT_MAX_REQ_PER_SEC', 5)

export function waitForShyftRateLimit(): Promise<void> {
  return limiter.wait()
}

export function shyftRateLimitDelayMs(attempt: number): number {
  return limiter.delayMs(attempt)
}
