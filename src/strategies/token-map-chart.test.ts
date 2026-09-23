import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/utils/gmgn-api', () => ({
  tokenKline: vi.fn(),
}))
vi.mock('@/utils/solanatracker-ohlc-limit', () => ({
  acquireSolanaTrackerOhlcSlot: vi.fn(async () => undefined),
}))

import { tokenKline } from '@/utils/gmgn-api'
import { acquireSolanaTrackerOhlcSlot } from '@/utils/solanatracker-ohlc-limit'
import {
  buildSolanaTrackerOhlcRequest,
  fetchTokenOhlc,
  getCachedTokenOhlc24h1m,
  mapGmgnKlineBars,
  tokenOhlcToRugBars,
} from '@/strategies/token-map-chart'

const SECURE_CHART =
  'https://ivory-badger-5278.secure.data.solanatracker.io/chart/'

const mint = 'So11111111111111111111111111111111111111112'

function stubUpstreamOnly() {
  vi.stubEnv('MARKET_BRAIN_TOKEN', '')
  vi.stubEnv('MARKET_BRAIN_OHLC', '0')
  vi.stubEnv('SOLANATRACKER_DATA_API_BASE', '')
  vi.stubEnv('SOLANATRACKER_CHART_BASE', '')
}

describe('fetchTokenOhlc', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('fetches the secure host without an API key when the key is unset', async () => {
    stubUpstreamOnly()
    vi.stubEnv('SOLANATRACKER_DATA_API_KEY', '')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        oclhv: [{ time: 1700000000, open: 1, high: 2, low: 0.5, close: 1.5 }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchTokenOhlc({
      tokenAddress: mint,
      hours: 24,
    })

    expect(result.source).toBe('solanatracker')
    expect(String(fetchMock.mock.calls[0]![0])).toContain(SECURE_CHART)
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain('api_key')
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.headers).toBeUndefined()
    expect(acquireSolanaTrackerOhlcSlot).toHaveBeenCalledOnce()
  })

  it('maps oclhv bars from Solana Tracker Data API', async () => {
    stubUpstreamOnly()
    vi.stubEnv('SOLANATRACKER_DATA_API_KEY', 'test-key')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        oclhv: [
          {
            time: 1700000000,
            open: 1,
            high: 2,
            low: 0.5,
            close: 1.5,
            volume: 100,
          },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchTokenOhlc({
      tokenAddress: 'So11111111111111111111111111111111111111112',
      hours: 24,
    })

    expect(result.source).toBe('solanatracker')
    expect(result.candles).toEqual([
      {
        time: 1700000000,
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        volume: 100,
      },
    ])
    expect(fetchMock).toHaveBeenCalledOnce()
    const calledUrl = String(fetchMock.mock.calls[0]![0])
    expect(calledUrl).toContain(SECURE_CHART)
    expect(calledUrl).toContain('type=5m')
    expect(calledUrl).toContain('currency=usd')
    expect(calledUrl).not.toContain('api_key')
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.headers).toBeUndefined()
    expect(tokenKline).not.toHaveBeenCalled()
  })

  it('returns empty on non-OK response', async () => {
    stubUpstreamOnly()
    vi.stubEnv('SOLANATRACKER_DATA_API_KEY', 'test-key')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    )
    const result = await fetchTokenOhlc({
      tokenAddress: 'So11111111111111111111111111111111111111112',
      hours: 6,
    })
    expect(result).toEqual({ candles: [], source: 'none' })
    expect(tokenKline).toHaveBeenCalledOnce()
  })

  it('retries SolanaTracker on 429 then returns candles', async () => {
    stubUpstreamOnly()
    vi.stubEnv('SOLANATRACKER_DATA_API_KEY', 'test-key')
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          oclhv: [
            {
              time: 1700000000,
              open: 1,
              high: 2,
              low: 0.5,
              close: 1.5,
              volume: 10,
            },
          ],
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const pending = fetchTokenOhlc({
      tokenAddress: 'So11111111111111111111111111111111111111112',
      hours: 24,
    })
    await vi.runAllTimersAsync()
    const result = await pending

    expect(result.source).toBe('solanatracker')
    expect(result.candles).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })

  it('uses GMGN kline for 0x / robinhood addresses', async () => {
    stubUpstreamOnly()
    vi.mocked(tokenKline).mockResolvedValue({
      list: [
        {
          time: 1700000000000,
          open: 1,
          high: 2,
          low: 0.5,
          close: 1.5,
          volume: 9,
        },
      ],
    })
    const result = await fetchTokenOhlc({
      tokenAddress: '0x1111111111111111111111111111111111111111',
      hours: 24,
      chain: 'robinhood',
    })
    expect(result.source).toBe('gmgn')
    expect(result.candles).toEqual([
      {
        time: 1700000000,
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        volume: 9,
      },
    ])
    expect(tokenKline).toHaveBeenCalledOnce()
    expect(acquireSolanaTrackerOhlcSlot).not.toHaveBeenCalled()
  })

  it('prefers brain GET /ohlc when token is set', async () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', 'read-token')
    vi.stubEnv('SOLANATRACKER_DATA_API_KEY', 'test-key')
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.includes('/ohlc?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            mint,
            chain: 'sol',
            interval: '5m',
            source: 'solanatracker',
            candles: [
              { time: 1700000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 4 },
            ],
          }),
        }
      }
      throw new Error(`unexpected fetch ${href}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchTokenOhlc({ tokenAddress: mint, hours: 24 })
    expect(result.source).toBe('brain:solanatracker')
    expect(result.candles).toEqual([
      { time: 1700000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 4 },
    ])
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/ohlc?')
    expect(String(fetchMock.mock.calls[0]![0])).toContain('hours=24')
    expect(String(fetchMock.mock.calls[0]![0])).toContain('interval=5m')
    expect(tokenKline).not.toHaveBeenCalled()
  })

  it('falls back to SolanaTracker on brain 5xx', async () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', 'read-token')
    vi.stubEnv('SOLANATRACKER_DATA_API_KEY', 'test-key')
    vi.stubEnv('SOLANATRACKER_DATA_API_BASE', '')
    vi.stubEnv('SOLANATRACKER_CHART_BASE', '')
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.includes('/ohlc?')) {
        return { ok: false, status: 502, json: async () => ({ error: 'bad gateway' }) }
      }
      return {
        ok: true,
        json: async () => ({
          oclhv: [{ time: 1700000000, open: 1, high: 2, low: 0.5, close: 1.5 }],
        }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchTokenOhlc({ tokenAddress: mint, hours: 24 })
    expect(result.source).toBe('solanatracker')
    expect(result.candles).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/ohlc?')
    expect(String(fetchMock.mock.calls[1]![0])).toContain(SECURE_CHART)
    const init = fetchMock.mock.calls[1]![1] as RequestInit
    expect(init.headers).toBeUndefined()
  })

  it('falls back to SolanaTracker on brain timeout', async () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', 'read-token')
    vi.stubEnv('SOLANATRACKER_DATA_API_KEY', 'test-key')
    vi.stubEnv('SOLANATRACKER_DATA_API_BASE', '')
    vi.stubEnv('SOLANATRACKER_CHART_BASE', '')
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.includes('/ohlc?')) {
        throw new Error('The operation was aborted due to timeout')
      }
      return {
        ok: true,
        json: async () => ({
          oclhv: [{ time: 9, open: 1, high: 1, low: 1, close: 1 }],
        }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchTokenOhlc({ tokenAddress: mint, hours: 6 })
    expect(result.source).toBe('solanatracker')
    expect(result.candles).toHaveLength(1)
    expect(String(fetchMock.mock.calls[1]![0])).toContain('type=1m')
  })

  it('skips brain when MARKET_BRAIN_OHLC=0 even if token is set', async () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', 'read-token')
    vi.stubEnv('MARKET_BRAIN_OHLC', '0')
    vi.stubEnv('SOLANATRACKER_DATA_API_KEY', 'test-key')
    vi.stubEnv('SOLANATRACKER_DATA_API_BASE', '')
    vi.stubEnv('SOLANATRACKER_CHART_BASE', '')
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      expect(href).toContain(SECURE_CHART)
      return {
        ok: true,
        json: async () => ({
          oclhv: [{ time: 1, open: 1, high: 1, low: 1, close: 1 }],
        }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchTokenOhlc({ tokenAddress: mint, hours: 24 })
    expect(result.source).toBe('solanatracker')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('sends x-api-key only for an explicit public data host', async () => {
    stubUpstreamOnly()
    vi.stubEnv('SOLANATRACKER_DATA_API_BASE', 'https://data.solanatracker.io/chart')
    vi.stubEnv('SOLANATRACKER_DATA_API_KEY', 'test-key')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        oclhv: [{ time: 1, open: 1, high: 1, low: 1, close: 1 }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchTokenOhlc({ tokenAddress: mint, hours: 6 })
    expect(result.source).toBe('solanatracker')
    const calledUrl = String(fetchMock.mock.calls[0]![0])
    expect(calledUrl).toContain('https://data.solanatracker.io/chart/')
    expect(calledUrl).not.toContain('api_key')
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      headers: { 'x-api-key': 'test-key' },
    })
  })

  it('skips the public host without a key and uses GMGN', async () => {
    stubUpstreamOnly()
    vi.stubEnv('SOLANATRACKER_CHART_BASE', 'https://data.solanatracker.io?api_key=leak')
    vi.stubEnv('SOLANATRACKER_DATA_API_KEY', '')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(tokenKline).mockResolvedValue({
      list: [{ time: 1700000000, open: 1, high: 1, low: 1, close: 2 }],
    })

    const result = await fetchTokenOhlc({ tokenAddress: mint, hours: 24 })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(acquireSolanaTrackerOhlcSlot).not.toHaveBeenCalled()
    expect(result.source).toBe('gmgn')
    expect(result.candles[0]?.close).toBe(2)
  })

  it('falls through to GMGN when the secure host returns no bars', async () => {
    stubUpstreamOnly()
    vi.stubEnv('SOLANATRACKER_DATA_API_KEY', 'should-not-be-sent')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ oclhv: [] }),
      }),
    )
    vi.mocked(tokenKline).mockResolvedValue({
      list: [{ time: 10, open: 1, high: 1, low: 1, close: 1 }],
    })

    const result = await fetchTokenOhlc({ tokenAddress: mint, hours: 24 })
    expect(result.source).toBe('gmgn')
    expect(tokenKline).toHaveBeenCalledOnce()
  })
})

describe('buildSolanaTrackerOhlcRequest', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('prefers CHART_BASE and strips a trailing /chart plus api_key', () => {
    vi.stubEnv(
      'SOLANATRACKER_CHART_BASE',
      'https://other.secure.data.solanatracker.io/chart?api_key=leak',
    )
    vi.stubEnv('SOLANATRACKER_DATA_API_BASE', 'https://data.solanatracker.io')
    vi.stubEnv('SOLANATRACKER_DATA_API_KEY', 'test-key')

    const req = buildSolanaTrackerOhlcRequest({
      tokenAddress: mint,
      type: '1m',
      timeFrom: 10,
      timeTo: 20,
    })
    expect(req?.url).toContain(
      'https://other.secure.data.solanatracker.io/chart/',
    )
    expect(req?.url).not.toContain('api_key')
    expect(req?.url).not.toContain('leak')
    expect(req?.headers).toEqual({})
  })

  it('returns null for the public host when no key is set', () => {
    vi.stubEnv('SOLANATRACKER_CHART_BASE', '')
    vi.stubEnv('SOLANATRACKER_DATA_API_BASE', 'https://data.solanatracker.io')
    vi.stubEnv('SOLANATRACKER_DATA_API_KEY', '')
    expect(
      buildSolanaTrackerOhlcRequest({
        tokenAddress: mint,
        type: '5m',
        timeFrom: 1,
        timeTo: 2,
      }),
    ).toBeNull()
  })

  it('returns null for an invalid base', () => {
    vi.stubEnv('SOLANATRACKER_DATA_API_BASE', 'not a url')
    vi.stubEnv('SOLANATRACKER_CHART_BASE', '')
    expect(
      buildSolanaTrackerOhlcRequest({
        tokenAddress: mint,
        type: '5m',
        timeFrom: 1,
        timeTo: 2,
      }),
    ).toBeNull()
  })
})

describe('mapGmgnKlineBars', () => {
  it('maps list bars and converts ms timestamps', () => {
    expect(
      mapGmgnKlineBars({
        list: [{ time: 1_700_000_000_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 3 }],
      }),
    ).toEqual([
      {
        time: 1_700_000_000,
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        volume: 3,
      },
    ])
  })
})

describe('getCachedTokenOhlc24h1m', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('uses interval=1m for 24h fetch', async () => {
    stubUpstreamOnly()
    vi.stubEnv('SOLANATRACKER_DATA_API_KEY', 'test-key')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        oclhv: [
          { time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
          { time: 2, open: 1.5, high: 2, low: 1, close: 1.2 },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await getCachedTokenOhlc24h1m(mint)
    expect(result.candles).toHaveLength(2)
    const calledUrl = String(fetchMock.mock.calls[0]![0])
    expect(calledUrl).toContain('type=1m')
  })

  it('maps candles to rug bars', () => {
    const bars = tokenOhlcToRugBars([
      { time: 10, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 },
    ])
    expect(bars).toEqual([{ t: 10, o: 1, h: 2, l: 0.5, c: 1.5, v: 3 }])
  })

  it('second call hits cache (one ST fetch)', async () => {
    stubUpstreamOnly()
    vi.stubEnv('SOLANATRACKER_DATA_API_KEY', 'test-key')
    const uniqueMint = `CacheTest${Date.now()}111111111111111111111`
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        oclhv: [{ time: 1, open: 1, high: 1, low: 1, close: 1 }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await getCachedTokenOhlc24h1m(uniqueMint)
    await getCachedTokenOhlc24h1m(uniqueMint)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('falls through to ST when cacheGet hangs past timeout', async () => {
    vi.resetModules()
    vi.doMock('@/utils/redis-cache', () => ({
      cacheGet: () => new Promise(() => undefined),
      cacheSet: vi.fn().mockResolvedValue(undefined),
    }))
    stubUpstreamOnly()
    vi.stubEnv('SOLANATRACKER_DATA_API_KEY', 'test-key')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        oclhv: [{ time: 9, open: 1, high: 1, low: 1, close: 1 }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { getCachedTokenOhlc24h1m: getCached } = await import(
      '@/strategies/token-map-chart'
    )
    const result = await getCached(`HangTest${Date.now()}1111111111111111111`)
    expect(result.candles).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('prefers brain 1m bars for the 24h cache path', async () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', 'read-token')
    vi.stubEnv('SOLANATRACKER_DATA_API_KEY', 'test-key')
    const uniqueMint = `BrainCache${Date.now()}1111111111111111111`
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.includes('/ohlc?')) {
        expect(href).toContain('interval=1m')
        expect(href).toContain('hours=24')
        return {
          ok: true,
          status: 200,
          json: async () => ({
            mint: uniqueMint,
            interval: '1m',
            source: 'cache',
            candles: [{ time: 11, open: 1, high: 1, low: 1, close: 1 }],
          }),
        }
      }
      throw new Error(`unexpected fetch ${href}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await getCachedTokenOhlc24h1m(uniqueMint)
    expect(result.source).toBe('brain:cache')
    expect(result.candles).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
