import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const redis = new Map<string, unknown>()
vi.mock('./redis-cache', () => ({
  cacheGet: vi.fn(async (k: string) => redis.get(k) ?? null),
  cacheSet: vi.fn(async (k: string, v: unknown) => {
    redis.set(k, v)
  }),
}))
const bybit = vi.fn()
vi.mock('./bybit-spot', () => ({ fetchBybitSpotLast: (...a: unknown[]) => bybit(...a) }))


describe('getSolPriceUSDCore under a Jupiter 429', () => {
  beforeEach(() => {
    redis.clear()
    bybit.mockReset().mockResolvedValue(0)
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-03T00:00:00Z'))
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('a Jupiter 429 backs Jupiter off ≥30s and serves the stale cached price', async () => {
    const calls: string[] = []
    const f = vi.fn(async (url: string | URL) => {
      const u = String(url)
      calls.push(u)
      if (u.includes('coingecko')) return new Response('{}', { status: 500 })
      return new Response('{}', { status: 429 })
    })
    vi.stubGlobal('fetch', f)
    const { getSolPriceUSDCore, getCachedPriceInfo } = await import('./sol-price-core')

    // Seed a 6-minute-old observed price (older than the 5-min "use stale without calling" window).
    redis.set('sol:price', {
      price: 140,
      timestamp: Date.now() - 6 * 60_000,
      expiresAt: 0,
      source: 'bybit',
      originalSource: 'bybit',
    })

    const r1 = await getSolPriceUSDCore()
    expect(r1).toEqual({ price: 140, source: 'stale_bybit' })
    const jupCalls1 = calls.filter((u) => u.includes('jup.ag')).length
    expect(jupCalls1).toBe(1) // no 1s-apart burst retries

    const info = getCachedPriceInfo().rate_limit_status.find((s) => s.api === 'jupiter')!
    expect(info.backoff_until).not.toBeNull()
    expect(new Date(info.backoff_until!).getTime() - Date.now()).toBeGreaterThanOrEqual(29_000)

    // Second call inside the window: Jupiter is not touched again.
    const r2 = await getSolPriceUSDCore()
    expect(r2.price).toBe(140)
    expect(calls.filter((u) => u.includes('jup.ag')).length).toBe(jupCalls1)
  })
})
