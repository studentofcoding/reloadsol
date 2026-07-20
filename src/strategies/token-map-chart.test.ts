import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchTokenOhlc,
  getCachedTokenOhlc24h1m,
  tokenOhlcToRugBars,
} from '@/strategies/token-map-chart'

const mint = 'So11111111111111111111111111111111111111112'

describe('fetchTokenOhlc', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('returns empty when SOLANATRACKER_DATA_API_KEY is unset', async () => {
    vi.stubEnv('SOLANATRACKER_DATA_API_KEY', '')
    const result = await fetchTokenOhlc({
      tokenAddress: 'So11111111111111111111111111111111111111112',
      hours: 24,
    })
    expect(result.candles).toEqual([])
    expect(result.source).toBe('none')
  })

  it('maps oclhv bars from Solana Tracker Data API', async () => {
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
})

describe('getCachedTokenOhlc24h1m', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('uses interval=1m for 24h fetch', async () => {
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
})
