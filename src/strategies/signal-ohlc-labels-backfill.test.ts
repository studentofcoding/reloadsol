import { afterEach, describe, expect, it, vi } from 'vitest'

describe('backfillEmptySignalOhlcBars', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('fills empty bars from 24h cache and skips when backfill_empty', async () => {
    const updateCalls: unknown[] = []
    vi.doMock('@/utils/db', () => ({
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        updateCalls.push({ sql, params })
        return { rows: [], rowCount: 1 }
      }),
      queryOne: vi.fn(async (sql: string, params?: unknown[]) => {
        if (String(sql).includes('UPDATE')) {
          return {
            id: 'row-1',
            token_address: 'Mint1111111111111111111111111111111111111',
            token_symbol: 'TEST',
            label: 'potential',
            window_start: new Date(1_700_000_000_000).toISOString(),
            window_end: new Date(1_700_000_600_000).toISOString(),
            ohlc_interval: '1m',
            ohlc_source: 'solanatracker',
            bars: [
              { t: 1_700_000_000, o: 1, h: 1.1, l: 0.9, c: 1.05 },
            ],
            end_reason: null,
            source: null,
            created_at: new Date().toISOString(),
          }
        }
        return null
      }),
    }))
    vi.doMock('@/utils/redis-cache', () => ({
      cacheDelByPrefix: vi.fn().mockResolvedValue(undefined),
      cacheGet: vi.fn().mockResolvedValue(null),
      cacheSet: vi.fn().mockResolvedValue(undefined),
    }))
    vi.doMock('@/strategies/token-map-chart', () => ({
      getCachedTokenOhlc24h1m: vi.fn().mockResolvedValue({
        candles: Array.from({ length: 12 }, (_, i) => ({
          time: 1_700_000_000 + i * 60,
          open: 1,
          high: 1.1,
          low: 0.9,
          close: 1,
        })),
        source: 'solanatracker',
      }),
      fetchTokenOhlc: vi.fn().mockResolvedValue({ candles: [], source: 'none' }),
      tokenOhlcToRugBars: (
        candles: Array<{
          time: number
          open: number
          high: number
          low: number
          close: number
        }>,
      ) =>
        candles.map((c) => ({
          t: c.time,
          o: c.open,
          h: c.high,
          l: c.low,
          c: c.close,
        })),
    }))

    const { backfillEmptySignalOhlcBars } = await import(
      './signal-ohlc-labels'
    )

    const empty = {
      id: 'row-1',
      token_address: 'Mint1111111111111111111111111111111111111',
      token_symbol: 'TEST',
      label: 'potential' as const,
      window_start: new Date(1_700_000_000_000).toISOString(),
      window_end: new Date(1_700_000_600_000).toISOString(),
      ohlc_interval: '1m',
      ohlc_source: 'none',
      bars: [] as Array<{ t: number; o: number; h: number; l: number; c: number }>,
      end_reason: null,
      source: null,
      created_at: new Date().toISOString(),
    }

    const filled = await backfillEmptySignalOhlcBars(empty)
    expect(filled.bars.length).toBeGreaterThan(0)
    expect(filled.ohlc_source).not.toBe('none')

    const skipped = await backfillEmptySignalOhlcBars({
      ...empty,
      ohlc_source: 'backfill_empty',
    })
    expect(skipped.bars).toEqual([])
    expect(skipped.ohlc_source).toBe('backfill_empty')
  })
})
