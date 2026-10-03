import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  rows: new Map<string, { meta: Record<string, unknown>; fetchedAtMs: number }>(),
  saved: [] as Array<{ mint: string; meta: Record<string, unknown> }>,
}))
vi.mock('@/utils/jupiter-meta-store', () => ({
  loadJupiterMetaRows: vi.fn(async (mints: string[]) => {
    const out = new Map<string, { meta: Record<string, unknown>; fetchedAtMs: number }>()
    for (const m of mints) {
      const row = store.rows.get(m)
      if (row) out.set(m, row)
    }
    return out
  }),
  saveJupiterMetaRows: vi.fn(async (rows: Array<{ mint: string; meta: Record<string, unknown> }>) => {
    store.saved.push(...rows)
  }),
}))

import { resetJupiterRpsForTests } from './jupiter-rps'
import {
  JUPITER_IMMUTABLE_MAX_AGE_MS,
  JupiterTokenNotFoundError,
  JupiterUnavailableError,
  __resetJupiterMetadataForTests,
  fetchJupiterMarketHints,
  fetchJupiterV2SearchRaw,
  fetchTokenMetadataFromJupiter,
  fetchTokensFromJupiterV2,
  getJupiterMetadataStats,
  isJupiterUnavailable,
  isPlausibleMint,
  jitteredRetryDelayMs,
  jupiterMetadataCooldownRemainingMs,
  jupiterRateLimitCooldownMs,
  lookupJupiterMetadata,
} from './jupiter-metadata'

const SOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const SECRET = 'jup_test_secret_key_1234567890'

function tok(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    decimals: 6,
    symbol: `S${id.slice(0, 3)}`,
    name: `N${id.slice(0, 3)}`,
    icon: 'https://img/x.png',
    usdPrice: 1.5,
    mcap: 1_000_000,
    bondingCurve: 100,
    ...extra,
  }
}

function res(status: number, body: unknown = [], headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
}

/** A fetch mock that answers every comma-separated id in `?query=` with a token. */
function echoFetch(extra: Record<string, unknown> = {}) {
  return vi.fn(async (url: string) => {
    const ids = decodeURIComponent(new URL(url).searchParams.get('query') ?? '').split(',')
    return res(200, ids.filter(Boolean).map((id) => tok(id, extra)))
  })
}

const queryOf = (call: unknown[]) =>
  decodeURIComponent(new URL(String(call[0])).searchParams.get('query') ?? '')
const headersOf = (call: unknown[]) => ((call[1] as RequestInit)?.headers ?? {}) as Record<string, string>

/** Start `p`, let timers run `ms`, then resolve/reject with its outcome. */
async function settle<T>(p: Promise<T>, ms = 300): Promise<T> {
  const outcome = p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  )
  await vi.advanceTimersByTimeAsync(ms)
  const o = await outcome
  if (!o.ok) throw o.e
  return o.v
}

function mintN(i: number): string {
  const alphabet = 'abcdefghijkmnopqrstu'
  let s = ''
  let n = i
  do {
    s = alphabet[n % alphabet.length] + s
    n = Math.floor(n / alphabet.length)
  } while (n > 0)
  return 'A'.repeat(40 - s.length) + s
}

describe('pure helpers', () => {
  const noJitter = () => 0
  it('cooldown prefers x-ratelimit-reset (absolute epoch seconds), then Retry-After, then the 10s window', () => {
    const now = 1_800_000_000_000
    expect(jupiterRateLimitCooldownMs({ reset: String(now / 1000 + 6) }, now, noJitter)).toBe(6_000)
    expect(jupiterRateLimitCooldownMs({ retryAfter: '20' }, now, noJitter)).toBe(20_000)
    expect(jupiterRateLimitCooldownMs({}, now, noJitter)).toBe(10_000)
    expect(jupiterRateLimitCooldownMs({ retryAfter: 'soon' }, now, noJitter)).toBe(10_000)
  })
  it('cooldown is clamped to [2s, 30s] and gets up to +20% jitter', () => {
    const now = 1_800_000_000_000
    expect(jupiterRateLimitCooldownMs({ retryAfter: '0' }, now, noJitter)).toBe(2_000)
    expect(jupiterRateLimitCooldownMs({ retryAfter: '3600' }, now, noJitter)).toBe(30_000)
    expect(jupiterRateLimitCooldownMs({ retryAfter: '10' }, now, () => 0.999)).toBeLessThanOrEqual(12_000)
    expect(jupiterRateLimitCooldownMs({ retryAfter: '10' }, now, () => 0.999)).toBeGreaterThan(11_900)
  })
  it('honours a Retry-After HTTP date', () => {
    const now = Date.parse('2026-10-04T00:00:00Z')
    expect(jupiterRateLimitCooldownMs({ retryAfter: 'Sun, 04 Oct 2026 00:00:30 GMT' }, now, noJitter)).toBe(30_000)
  })
  it('transient retry delay stays within ±25% of the 400/800/1600 ladder', () => {
    expect(jitteredRetryDelayMs(0, () => 0)).toBe(300)
    expect(jitteredRetryDelayMs(0, () => 1)).toBe(500)
    expect(jitteredRetryDelayMs(1, () => 0.5)).toBe(800)
    expect(jitteredRetryDelayMs(9, () => 0.5)).toBe(1600)
  })
  it('isPlausibleMint rejects names, symbols and junk', () => {
    expect(isPlausibleMint(SOL)).toBe(true)
    expect(isPlausibleMint('bonk')).toBe(false)
    expect(isPlausibleMint('')).toBe(false)
    expect(isPlausibleMint('0'.repeat(40))).toBe(false)
  })
})

describe('jupiter-metadata stats line', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
  it('logs one stats line per 10 minutes via console.warn (console.log is stripped in prod builds)', async () => {
    vi.useFakeTimers()
    __resetJupiterMetadataForTests()
    resetJupiterRpsForTests()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('fetch', echoFetch())
    await settle(fetchTokenMetadataFromJupiter(SOL))
    expect(warn.mock.calls.some((c) => String(c[0]).includes('[jupiter-metadata] stats'))).toBe(false)
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    await settle(fetchTokenMetadataFromJupiter(USDC))
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[jupiter-metadata] stats'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/upstream_mints=2 keyless_req=2 keyed_req=0 429_keyless=0 429_keyed=0/)
    expect(log.mock.calls.some((c) => String(c[0]).includes('stats'))).toBe(false)
  })
})

describe('jupiter-metadata queue / cache / gate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    store.rows.clear()
    store.saved.length = 0
    delete process.env.JUPITER_API_KEY
    delete process.env.JUPITER_META_RPS
    delete process.env.JUPITER_META_BURST
    delete process.env.JUPITER_META_KEYLESS
    __resetJupiterMetadataForTests()
    resetJupiterRpsForTests()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('concurrent single-mint callers share ONE keyless api.jup.ag request (comma-separated, no key)', async () => {
    process.env.JUPITER_API_KEY = SECRET
    const fetchMock = echoFetch()
    vi.stubGlobal('fetch', fetchMock)

    const [a, b, c] = await settle(
      Promise.all([
        fetchTokenMetadataFromJupiter(SOL),
        fetchTokenMetadataFromJupiter(USDC),
        fetchTokenMetadataFromJupiter(USDT),
      ]),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0] as unknown[]
    expect(String(call[0]).startsWith('https://api.jup.ag/tokens/v2/search?query=')).toBe(true)
    expect(queryOf(call).split(',').sort()).toEqual([SOL, USDC, USDT].sort())
    expect(headersOf(call)['x-api-key']).toBeUndefined() // keyless lane never sends the key
    expect(a.symbol).toBe(`S${SOL.slice(0, 3)}`)
    expect(b.symbol).toBe(`S${USDC.slice(0, 3)}`)
    expect(c.decimals).toBe(6)
  })

  it('the same mint asked five ways in one tick is one upstream mint', async () => {
    const fetchMock = echoFetch()
    vi.stubGlobal('fetch', fetchMock)
    const [raw, meta, hints] = await settle(
      Promise.all([
        fetchJupiterV2SearchRaw(SOL),
        fetchTokenMetadataFromJupiter(SOL),
        fetchJupiterMarketHints(SOL),
        fetchTokenMetadataFromJupiter(SOL),
        fetchJupiterV2SearchRaw(SOL),
      ]),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(queryOf(fetchMock.mock.calls[0] as unknown[])).toBe(SOL)
    expect(Array.isArray(raw) && (raw as unknown[]).length).toBe(1)
    expect(meta).toMatchObject({ decimals: 6 })
    expect(hints).toMatchObject({ usdPrice: 1.5, mcap: 1_000_000 })
  })

  it('caches: metadata for 10 min, market hints only 10 s', async () => {
    const fetchMock = echoFetch()
    vi.stubGlobal('fetch', fetchMock)
    await settle(fetchTokenMetadataFromJupiter(SOL))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // within 10s everything is served from the cache, hints included
    await settle(fetchTokenMetadataFromJupiter(SOL), 5_000)
    expect(await fetchJupiterMarketHints(SOL)).toMatchObject({ mcap: 1_000_000 })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // 11 s later: metadata still fresh, market hints are not
    await vi.advanceTimersByTimeAsync(6_000)
    await settle(fetchTokenMetadataFromJupiter(SOL))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await settle(fetchJupiterMarketHints(SOL), 4_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // 10+ minutes later metadata is re-asked
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    await settle(fetchTokenMetadataFromJupiter(SOL), 4_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('a not-found answer is negative-cached (and is NOT "unavailable")', async () => {
    const fetchMock = vi.fn(async () => res(200, []))
    vi.stubGlobal('fetch', fetchMock)
    await expect(settle(fetchTokenMetadataFromJupiter(SOL))).rejects.toBeInstanceOf(JupiterTokenNotFoundError)
    await expect(settle(fetchTokenMetadataFromJupiter(SOL))).rejects.toThrow('Token not found')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await settle(fetchJupiterV2SearchRaw(SOL))).toEqual([])
    expect(await fetchJupiterMarketHints(SOL)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(91_000)
    await expect(settle(fetchTokenMetadataFromJupiter(SOL), 4_000)).rejects.toBeInstanceOf(JupiterTokenNotFoundError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('names, symbols and junk never reach the network and read as not found', async () => {
    const fetchMock = echoFetch()
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchJupiterV2SearchRaw('bonk')).toEqual([])
    await expect(fetchTokenMetadataFromJupiter('bonk')).rejects.toBeInstanceOf(JupiterTokenNotFoundError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keyless 429 -> keyed fallback (x-api-key), and the next batch goes straight to keyed', async () => {
    process.env.JUPITER_API_KEY = SECRET
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>
      if (!h['x-api-key']) return res(429, 'Too many requests', { 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 8) })
      const ids = decodeURIComponent(new URL(url).searchParams.get('query') ?? '').split(',')
      return res(200, ids.map((id) => tok(id)))
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(settle(fetchTokenMetadataFromJupiter(SOL))).resolves.toMatchObject({ decimals: 6 })
    expect(fetchMock).toHaveBeenCalledTimes(2) // keyless 429, then keyed 200
    expect(headersOf(fetchMock.mock.calls[0] as unknown[])['x-api-key']).toBeUndefined()
    expect(headersOf(fetchMock.mock.calls[1] as unknown[])['x-api-key']).toBe(SECRET)

    // keyless is cooling down: a different mint goes directly to keyed (1 request, not 2)
    await settle(fetchTokenMetadataFromJupiter(USDC), 4_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(headersOf(fetchMock.mock.calls[2] as unknown[])['x-api-key']).toBe(SECRET)
    expect(getJupiterMetadataStats().rateLimited.keyless).toBe(1)
  })

  it('429 with no key: unavailable (never not-found), one request, then fail fast during the cooldown', async () => {
    const fetchMock = vi.fn(async () => res(429, 'Rate limit exceeded', { 'retry-after': '10' }))
    vi.stubGlobal('fetch', fetchMock)

    const err = await settle(fetchTokenMetadataFromJupiter(SOL)).catch((e) => e)
    expect(isJupiterUnavailable(err)).toBe(true)
    expect(err).toBeInstanceOf(JupiterUnavailableError)
    expect(err).not.toBeInstanceOf(JupiterTokenNotFoundError)
    expect(err.reason).toBe('rate_limited')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(jupiterMetadataCooldownRemainingMs()).toBeGreaterThan(9_000)

    // every entry point now fails fast without touching the network
    await expect(settle(fetchTokensFromJupiterV2([USDC]))).rejects.toThrow(/cooldown/)
    await expect(settle(fetchJupiterV2SearchRaw(USDT))).rejects.toBeInstanceOf(JupiterUnavailableError)
    expect(await settle(fetchJupiterMarketHints(USDT))).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // and unavailability was not cached as "no such token": once the window passes it asks again
    await vi.advanceTimersByTimeAsync(13_000)
    fetchMock.mockImplementation(async () => res(200, [tok(SOL)]))
    await expect(settle(fetchTokenMetadataFromJupiter(SOL), 4_000)).resolves.toMatchObject({ decimals: 6 })
  })

  it('an unavailable error never carries the API key', async () => {
    process.env.JUPITER_API_KEY = SECRET
    vi.stubGlobal('fetch', vi.fn(async () => res(429, 'nope')))
    const err = await settle(fetchTokenMetadataFromJupiter(SOL)).catch((e) => e)
    expect(isJupiterUnavailable(err)).toBe(true)
    expect(String(err.message)).not.toContain(SECRET)
    const logged = JSON.stringify((console.warn as unknown as { mock: { calls: unknown[] } }).mock.calls)
    expect(logged).not.toContain(SECRET)
  })

  it('serves a stale (<=6h) record when Jupiter is unavailable, but never stale market hints', async () => {
    const ok = echoFetch()
    vi.stubGlobal('fetch', ok)
    await settle(fetchTokenMetadataFromJupiter(SOL))
    await vi.advanceTimersByTimeAsync(30 * 60_000) // metadata now older than 10 min

    vi.stubGlobal('fetch', vi.fn(async () => res(429, 'nope')))
    await expect(settle(fetchTokenMetadataFromJupiter(SOL), 4_000)).resolves.toMatchObject({ decimals: 6 })
    expect(getJupiterMetadataStats().staleServed).toBe(1)
    expect(await settle(fetchJupiterMarketHints(SOL), 4_000)).toBeNull()
  })

  it('the keyless gate spaces batches at JUPITER_META_RPS (0.3 rps ~ 3.3s) once the burst is spent', async () => {
    process.env.JUPITER_META_BURST = '1'
    const stamps: number[] = []
    const fetchMock = vi.fn(async (url: string) => {
      stamps.push(Date.now())
      const ids = decodeURIComponent(new URL(url).searchParams.get('query') ?? '').split(',')
      return res(200, ids.map((id) => tok(id)))
    })
    vi.stubGlobal('fetch', fetchMock)

    const first = fetchTokenMetadataFromJupiter(mintN(1))
    await vi.advanceTimersByTimeAsync(400) // first flush goes out
    const second = fetchTokenMetadataFromJupiter(mintN(2))
    const third = fetchTokenMetadataFromJupiter(mintN(3))
    await vi.advanceTimersByTimeAsync(10_000)
    await Promise.all([first, second, third])

    expect(fetchMock).toHaveBeenCalledTimes(2) // 2 and 3 were coalesced into one request
    expect(queryOf(fetchMock.mock.calls[1] as unknown[]).split(',').length).toBe(2)
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(3_000)
  })

  it('many mints are split into <=100-mint requests, paced, and every caller is answered', async () => {
    const fetchMock = echoFetch()
    vi.stubGlobal('fetch', fetchMock)
    const mints = Array.from({ length: 250 }, (_, i) => mintN(i))
    const out = await settle(lookupJupiterMetadata(mints), 20_000)
    expect(Object.keys(out.found).length).toBe(250)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const sizes = fetchMock.mock.calls.map((c) => queryOf(c as unknown[]).split(',').length)
    expect(Math.max(...sizes)).toBe(100)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(250)
  })

  it('a non-429 4xx is not retried and does not open the cooldown', async () => {
    const fetchMock = vi.fn(async () => res(400, 'bad'))
    vi.stubGlobal('fetch', fetchMock)
    const err = await settle(fetchJupiterV2SearchRaw(SOL)).catch((e) => e)
    expect(String((err as Error).message)).toMatch(/HTTP 400/)
    expect(isJupiterUnavailable(err)).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(jupiterMetadataCooldownRemainingMs()).toBe(0)
  })

  it('a 5xx is retried once with backoff, then succeeds; two in a row is "unavailable"', async () => {
    const flaky = vi
      .fn()
      .mockResolvedValueOnce(res(504, 'gateway'))
      .mockResolvedValueOnce(res(200, [tok(SOL)]))
    vi.stubGlobal('fetch', flaky)
    await expect(settle(fetchTokenMetadataFromJupiter(SOL), 5_000)).resolves.toMatchObject({ decimals: 6 })
    expect(flaky).toHaveBeenCalledTimes(2)

    const down = vi.fn(async () => res(503, 'down'))
    vi.stubGlobal('fetch', down)
    const err = await settle(fetchTokenMetadataFromJupiter(USDC), 10_000).catch((e) => e)
    expect(isJupiterUnavailable(err) && err.reason).toBe('upstream_5xx')
    expect(down).toHaveBeenCalledTimes(2)
  })

  it('a stalled response BODY is aborted by the request timeout (was: hung forever)', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const r = res(200, [])
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
    const err = await settle(fetchJupiterV2SearchRaw(SOL), 60_000).catch((e) => e)
    expect(isJupiterUnavailable(err) && err.reason).toBe('timeout')
    expect(String((err as Error).message)).toMatch(/timeout after 10 seconds/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('L2: a fresh persisted row answers without any request; a stale row backs up an outage', async () => {
    const meta = { decimals: 9, symbol: 'SOL', name: 'Wrapped SOL', graduatedPool: null }
    store.rows.set(SOL, { meta, fetchedAtMs: Date.now() - 60_000 })
    const fetchMock = echoFetch()
    vi.stubGlobal('fetch', fetchMock)
    await expect(settle(fetchTokenMetadataFromJupiter(SOL))).resolves.toMatchObject({ symbol: 'SOL', decimals: 9 })
    expect(fetchMock).not.toHaveBeenCalled()

    // a 1-hour-old row is too old for the default 10 min, fine for an immutable-fields caller
    store.rows.set(USDC, { meta: { ...meta, symbol: 'USDC', decimals: 6 }, fetchedAtMs: Date.now() - 3_600_000 })
    await expect(
      settle(fetchTokenMetadataFromJupiter(USDC, { maxAgeMs: JUPITER_IMMUTABLE_MAX_AGE_MS })),
    ).resolves.toMatchObject({ symbol: 'USDC' })
    expect(fetchMock).not.toHaveBeenCalled()

    // ... and with Jupiter down the same stale row is still better than nothing
    vi.stubGlobal('fetch', vi.fn(async () => res(429, 'nope')))
    await expect(settle(fetchTokenMetadataFromJupiter(USDC), 4_000)).resolves.toMatchObject({ symbol: 'USDC' })
    expect(getJupiterMetadataStats().staleServed).toBe(1)
  })

  it('L2: every successful fetch is written through (one batched save)', async () => {
    vi.stubGlobal('fetch', echoFetch())
    await settle(Promise.all([fetchTokenMetadataFromJupiter(SOL), fetchTokenMetadataFromJupiter(USDC)]))
    expect(store.saved.map((r) => r.mint).sort()).toEqual([SOL, USDC].sort())
    expect(store.saved[0].meta).toMatchObject({ decimals: 6 })
  })

  it('fetchTokensFromJupiterV2 throws unavailable (not a partial "found") when a mint could not be resolved', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(429, 'nope')))
    await expect(settle(fetchTokensFromJupiterV2([SOL, USDC]))).rejects.toBeInstanceOf(JupiterUnavailableError)
  })
})
