import { createSerialRateLimiter } from '@/utils/serial-rate-limit'

const limiter = createSerialRateLimiter('RPC_MAX_REQ_PER_SEC', 5)

export function waitForRpcRateLimit(): Promise<void> {
  return limiter.wait()
}

export function rpcRateLimitDelayMs(attempt: number): number {
  return limiter.delayMs(attempt)
}
