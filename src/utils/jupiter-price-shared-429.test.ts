import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/redis-cache', () => ({
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => undefined),
  cacheSetNx: vi.fn(async () => true),
}))

import {
  __resetJupiterPriceBackoffForTests,
  fetchJupiterPriceRaw,
  getTokenPrice,
  jupiterPriceBackoffMs,
  jupiterPriceBackoffRemainingMs,
  noteJupiterPriceRateLimited,
} from './jupiter-api'
import { resetJupiterRpsForTests } from './jupiter-rps'
import { getUsdPrices, resetUsdPricesForTests } from './usd-prices'

const SOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const NOW = Date.parse('2026-10-04T00:00:00Z')
const ok = () => new Response(JSON.stringify({ [SOL]: { usdPrice: 150, decimals: 9 } }), { status: 200 })
const h = (o: Record<string, string>) => new Headers(o)

describe('shared keyed Price V3 429 handling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    process.env.JUPITER_API_KEY = 'test-key'
    __resetJupiterPriceBackoffForTests()
    resetUsdPricesForTests()
    resetJupiterRpsForTests()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('x-ratelimit-reset (epoch s) shortens the backoff to the end of the window (min 2s), not a blind 30s', () => {
    expect(jupiterPriceBackoffMs(null, NOW, String(NOW / 1000 + 6))).toBe(6_500)
    expect(jupiterPriceBackoffMs(null, NOW, String(NOW / 1000 + 0.2))).toBe(2_000)
    expect(jupiterPriceBackoffMs(null, NOW, String(NOW / 1000 - 5))).toBe(30_000) // stale reset -> default
    expect(jupiterPriceBackoffMs(null, NOW, 'junk')).toBe(30_000)
  })

  it('a 429 seen by jupiter-api.ts stops usd-prices.ts from calling Jupiter (one shared cooldown)', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 429, headers: h({ 'x-ratelimit-reset': String(NOW / 1000 + 8) }) }))
    vi.stubGlobal('fetch', f)
    await expect(getTokenPrice(SOL)).rejects.toMatchObject({ statusCode: 429 })
    expect(f).toHaveBeenCalledTimes(1)
    expect(jupiterPriceBackoffRemainingMs()).toBeGreaterThan(8_000)

    const r = await getUsdPrices([USDC])
    expect(r.prices[USDC]).toBeUndefined() // no data (caller falls back); not reported as 'unpriced'
    expect(r.unpriced).toEqual([])
    expect(f).toHaveBeenCalledTimes(1) // usd-prices did not spend a request in the cooldown

    vi.setSystemTime(NOW + 10_000)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ [USDC]: { usdPrice: 1 } }), { status: 200 })))
    expect((await getUsdPrices([USDC])).prices[USDC]).toBe(1)
  })

  it('a 429 seen by usd-prices.ts stops jupiter-api.ts too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })))
    await getUsdPrices([USDC])
    expect(jupiterPriceBackoffRemainingMs()).toBeGreaterThan(29_000)
    const f2 = vi.fn(async () => ok())
    vi.stubGlobal('fetch', f2)
    await expect(getTokenPrice(SOL)).rejects.toThrow(/429 backoff/)
    expect(f2).not.toHaveBeenCalled()
  })

  it('concurrent identical price lookups share ONE upstream request; a 3s result cache absorbs the next', async () => {
    const f = vi.fn(async () => ok())
    vi.stubGlobal('fetch', f)
    const out = await Promise.all([getTokenPrice(SOL), getTokenPrice(SOL), getTokenPrice(SOL)])
    expect(out).toEqual([150, 150, 150])
    expect(f).toHaveBeenCalledTimes(1)
    await getTokenPrice(SOL)
    expect(f).toHaveBeenCalledTimes(1)
    vi.setSystemTime(NOW + 4_000)
    await getTokenPrice(SOL)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('fetchJupiterPriceRaw respects the cooldown and records a 429', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 429 }))
    vi.stubGlobal('fetch', f)
    await expect(fetchJupiterPriceRaw(SOL)).rejects.toThrow(/price HTTP 429/)
    expect(jupiterPriceBackoffRemainingMs()).toBeGreaterThan(0)
    await expect(fetchJupiterPriceRaw(SOL)).rejects.toThrow(/429 backoff/)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('noteJupiterPriceRateLimited returns the applied backoff', () => {
    expect(noteJupiterPriceRateLimited(h({ 'retry-after': '12' }), NOW)).toBe(12_000)
  })
})
