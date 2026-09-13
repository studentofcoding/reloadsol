export const JUPITER_MAX_RPS = 5
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
