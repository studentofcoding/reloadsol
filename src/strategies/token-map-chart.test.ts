import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTokenOhlc } from '@/strategies/token-map-chart'

describe('fetchTokenOhlc', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
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
