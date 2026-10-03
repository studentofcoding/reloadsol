import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetJupiterMetadataForTests,
  fetchJupiterMarketHints,
  fetchJupiterV2SearchRaw,
  fetchTokenMetadataFromJupiter,
  fetchTokensFromJupiterV2,
  jitteredRetryDelayMs,
  jupiterMetadataCooldownMs,
  jupiterMetadataCooldownRemainingMs,
} from './jupiter-metadata'

const MINT = 'So11111111111111111111111111111111111111112'
const TOKEN = { id: MINT, decimals: 9, symbol: 'SOL', name: 'Wrapped SOL', usdPrice: 150, mcap: 1_000_000 }

function res(status: number, body: unknown = [], headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
}

describe('jupiterMetadataCooldownMs (pure)', () => {
  const noJitter = () => 0
  it('defaults to 15s with no header', () => {
    expect(jupiterMetadataCooldownMs(null, 0, noJitter)).toBe(15_000)
  })
  it('honours Retry-After seconds, clamped to [5s, 60s]', () => {
    expect(jupiterMetadataCooldownMs('20', 0, noJitter)).toBe(20_000)
    expect(jupiterMetadataCooldownMs('1', 0, noJitter)).toBe(5_000)
    expect(jupiterMetadataCooldownMs('3600', 0, noJitter)).toBe(60_000)
  })
  it('honours a Retry-After HTTP date', () => {
    const now = Date.parse('2026-10-04T00:00:00Z')
    expect(jupiterMetadataCooldownMs('Sun, 04 Oct 2026 00:00:30 GMT', now, noJitter)).toBe(30_000)
  })
  it('adds up to +20% jitter', () => {
    expect(jupiterMetadataCooldownMs('10', 0, () => 0.999)).toBeLessThanOrEqual(12_000)
    expect(jupiterMetadataCooldownMs('10', 0, () => 0.999)).toBeGreaterThan(11_900)
  })
  it('ignores garbage headers', () => {
    expect(jupiterMetadataCooldownMs('soon', 0, noJitter)).toBe(15_000)
  })
})

describe('jitteredRetryDelayMs', () => {
  it('stays within ±25% of the 400/800/1600 ladder', () => {
    expect(jitteredRetryDelayMs(0, () => 0)).toBe(300)
    expect(jitteredRetryDelayMs(0, () => 1)).toBe(500)
    expect(jitteredRetryDelayMs(1, () => 0.5)).toBe(800)
    expect(jitteredRetryDelayMs(9, () => 0.5)).toBe(1600)
  })
})

describe('jupiter-metadata fetch layer', () => {
  beforeEach(() => {
    __resetJupiterMetadataForTests()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('a 429 fails fast (no burst retries) and opens a shared cooldown', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(429, 'Rate limit exceeded', { 'retry-after': '10' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchTokenMetadataFromJupiter(MINT)).rejects.toThrow(/429/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(jupiterMetadataCooldownRemainingMs()).toBeGreaterThan(9_000)

    // every other entry point now fails fast without touching the network
    await expect(fetchTokensFromJupiterV2(['other-mint'])).rejects.toThrow(/cooldown/)
    await expect(fetchJupiterV2SearchRaw('third-mint')).rejects.toThrow(/cooldown/)
    expect(await fetchJupiterMarketHints('fourth-mint')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('concurrent callers for the same mint share ONE upstream request', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => res(200, [TOKEN]))
    vi.stubGlobal('fetch', fetchMock)

    const [raw, meta, hints] = await Promise.all([
      fetchJupiterV2SearchRaw(MINT),
      fetchTokenMetadataFromJupiter(MINT),
      fetchJupiterMarketHints(MINT),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(Array.isArray(raw)).toBe(true)
    expect(meta).toMatchObject({ decimals: 9, symbol: 'SOL' })
    expect(hints).toMatchObject({ usdPrice: 150, mcap: 1_000_000 })

    // once settled, a new call is a new request (no stale caching introduced)
    await fetchJupiterV2SearchRaw(MINT)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not dedupe different queries', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => res(200, []))
    vi.stubGlobal('fetch', fetchMock)
    await Promise.all([fetchJupiterV2SearchRaw('A'), fetchJupiterV2SearchRaw('B')])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries a 504 with backoff, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(504, 'gateway'))
      .mockResolvedValueOnce(res(200, [TOKEN]))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchTokenMetadataFromJupiter(MINT)).resolves.toMatchObject({ symbol: 'SOL' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a non-429 4xx is not retried and does not open the cooldown', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(400, 'bad'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchJupiterV2SearchRaw('x')).rejects.toThrow(/HTTP 400/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(jupiterMetadataCooldownRemainingMs()).toBe(0)
  })

  it('an unknown token still throws "Token not found"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(200, [])))
    await expect(fetchTokenMetadataFromJupiter(MINT)).rejects.toThrow('Token not found')
  })

  it('a stalled response BODY is aborted by the request timeout (was: hung forever)', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const r = res(200, [])
      // headers arrive, body never does — until the abort signal fires
      vi.spyOn(r, 'json').mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const e = new Error('aborted')
              e.name = 'AbortError'
              reject(e)
            })
          }),
      )
      return r
    })
    vi.stubGlobal('fetch', fetchMock)

    const settled = fetchJupiterV2SearchRaw('stall').then(
      () => 'resolved',
      (e: Error) => e.message,
    )
    await vi.advanceTimersByTimeAsync(120_000)
    const outcome = await settled
    expect(outcome).toMatch(/timeout after 10 seconds/)
    expect(fetchMock).toHaveBeenCalledTimes(4) // 1 + MAX_RETRIES
  })
})
