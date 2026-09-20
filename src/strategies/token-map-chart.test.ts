import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/utils/gmgn-api', () => ({
  tokenKline: vi.fn(),
}))

import { tokenKline } from '@/utils/gmgn-api'
import {
  fetchTokenOhlc,
  getCachedTokenOhlc24h1m,
  mapGmgnKlineBars,
  tokenOhlcToRugBars,
} from '@/strategies/token-map-chart'

const mint = 'So11111111111111111111111111111111111111112'

function stubUpstreamOnly() {
  vi.stubEnv('MARKET_BRAIN_TOKEN', '')
  vi.stubEnv('MARKET_BRAIN_OHLC', '0')
}

describe('fetchTokenOhlc', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('returns empty when SOLANATRACKER_DATA_API_KEY is unset', async () => {
    stubUpstreamOnly()
    vi.stubEnv('SOLANATRACKER_DATA_API_KEY', '')
    const result = await fetchTokenOhlc({
      tokenAddress: 'So11111111111111111111111111111111111111112',
      hours: 24,
    })
    expect(result.candles).toEqual([])
    expect(result.source).toBe('none')
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
    expect(calledUrl).toContain('data.solanatracker.io/chart/')
    expect(calledUrl).toContain('type=5m')
    expect(calledUrl).toContain('currency=usd')
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      headers: { 'x-api-key': 'test-key' },
    })
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
    expect(String(fetchMock.mock.calls[1]![0])).toContain('data.solanatracker.io/chart/')
  })

  it('falls back to SolanaTracker on brain timeout', async () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', 'read-token')
    vi.stubEnv('SOLANATRACKER_DATA_API_KEY', 'test-key')
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
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      expect(href).toContain('data.solanatracker.io/chart/')
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
