import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetJupiterPriceBackoffForTests,
  getTokenPrice,
  jupiterPriceBackoffMs,
  jupiterPriceBackoffRemainingMs,
} from './jupiter-api'

const SOL = 'So11111111111111111111111111111111111111112'
const priceOk = () => new Response(JSON.stringify({ [SOL]: { usdPrice: 150, decimals: 9 } }), { status: 200 })

describe('jupiter price API 429 handling', () => {
  beforeEach(() => {
    __resetJupiterPriceBackoffForTests()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-03T00:00:00Z'))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('does NOT burst-retry a 429 (was 3 more attempts 1s apart)', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 429 }))
    vi.stubGlobal('fetch', f)
    await expect(getTokenPrice(SOL)).rejects.toMatchObject({ isRateLimit: true, statusCode: 429 })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('opens a 30s window: further calls fail fast without touching the API, then recover', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 429 }))
    vi.stubGlobal('fetch', f)
    await expect(getTokenPrice(SOL)).rejects.toThrow(/Rate limited/)
    expect(jupiterPriceBackoffRemainingMs()).toBeGreaterThan(29_000)

    await expect(getTokenPrice(SOL)).rejects.toThrow(/429 backoff/)
    await expect(getTokenPrice(SOL)).rejects.toThrow(/429 backoff/)
    expect(f).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + 31_000)
    f.mockResolvedValueOnce(priceOk())
    await expect(getTokenPrice(SOL)).resolves.toBe(150)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('honours Retry-After, clamped to 5..60s', () => {
    const now = Date.parse('2026-10-03T00:00:00Z')
    expect(jupiterPriceBackoffMs(null, now)).toBe(30_000)
    expect(jupiterPriceBackoffMs('45', now)).toBe(45_000)
    expect(jupiterPriceBackoffMs('1', now)).toBe(5_000)
    expect(jupiterPriceBackoffMs('600', now)).toBe(60_000)
    expect(jupiterPriceBackoffMs('Sat, 03 Oct 2026 00:00:40 GMT', now)).toBe(40_000)
  })

  it('still retries transient non-429 failures', async () => {
    const f = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(priceOk())
    vi.stubGlobal('fetch', f)
    const p = getTokenPrice(SOL)
    await vi.advanceTimersByTimeAsync(1100)
    await expect(p).resolves.toBe(150)
    expect(f).toHaveBeenCalledTimes(2)
  })
})
