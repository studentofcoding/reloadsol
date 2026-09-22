import { afterEach, describe, expect, it, vi } from 'vitest'

const MINT = 'Mint1111111111111111111111111111111111111'

function emptyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    token_address: MINT,
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
    ...overrides,
  }
}

function barCandles(n = 12) {
  return Array.from({ length: n }, (_, i) => ({
    time: 1_700_000_000 + i * 60,
    open: 1,
    high: 1.1,
    low: 0.9,
    close: 1,
  }))
}

describe('backfillEmptySignalOhlcBars', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('fills empty none rows from cache; gallery cooldown skips backfill_empty until mcap refill', async () => {
    const updateCalls: unknown[] = []
    vi.doMock('@/utils/db', () => ({
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        updateCalls.push({ sql, params })
        return { rows: [], rowCount: 1 }
      }),
      queryOne: vi.fn(async (sql: string, params?: unknown[]) => {
        if (String(sql).includes('UPDATE')) {
          return {
            ...emptyRow(),
            ohlc_source: 'solanatracker',
            bars: [{ t: 1_700_000_000, o: 1, h: 1.1, l: 0.9, c: 1.05 }],
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
        candles: barCandles(),
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

    const filled = await backfillEmptySignalOhlcBars(emptyRow())
    expect(filled.bars.length).toBeGreaterThan(0)
    expect(filled.ohlc_source).not.toBe('none')

    const skipped = await backfillEmptySignalOhlcBars(
      emptyRow({ ohlc_source: 'backfill_empty' }),
    )
    expect(skipped.bars).toEqual([])
    expect(skipped.ohlc_source).toBe('backfill_empty')
  })

  it('force=true retries backfill_empty and soft-overwrites with bars', async () => {
    vi.doMock('@/utils/db', () => ({
      query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
      queryOne: vi.fn(async (sql: string) => {
        if (String(sql).includes('UPDATE')) {
          return {
            ...emptyRow({ ohlc_source: 'solanatracker' }),
            bars: [{ t: 1_700_000_000, o: 1, h: 1.1, l: 0.9, c: 1 }],
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
        candles: barCandles(),
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
    const filled = await backfillEmptySignalOhlcBars(
      emptyRow({ ohlc_source: 'backfill_empty' }),
      { force: true },
    )
    expect(filled.bars.length).toBeGreaterThan(0)
    expect(filled.ohlc_source).toBe('solanatracker')
  })
})

describe('captureSignalOhlcLabel empty / soft-overwrite', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('does not INSERT when fetch returns no bars (no UNIQUE lock)', async () => {
    const queryFn = vi.fn(async (sql: string) => {
      if (String(sql).includes('CREATE TABLE')) {
        return { rows: [], rowCount: 0 }
      }
      if (String(sql).includes('INSERT')) {
        throw new Error('must not INSERT empty corpus row')
      }
      return { rows: [], rowCount: 0 }
    })
    const queryOneFn = vi.fn(async (sql: string) => {
      if (String(sql).includes('FROM signal_ohlc_labels')) return null
      if (String(sql).includes('FROM trending_token_tracker') ||
          String(sql).includes('FROM token_mcap_tracking')) {
        return null
      }
      return null
    })
    vi.doMock('@/utils/db', () => ({
      query: queryFn,
      queryOne: queryOneFn,
    }))
    vi.doMock('@/utils/redis-cache', () => ({
      cacheDelByPrefix: vi.fn().mockResolvedValue(undefined),
      cacheGet: vi.fn().mockResolvedValue(null),
      cacheSet: vi.fn().mockResolvedValue(undefined),
    }))
    vi.doMock('@/strategies/token-map-chart', () => ({
      getCachedTokenOhlc24h1m: vi.fn().mockResolvedValue({
        candles: [],
        source: 'none',
      }),
      fetchTokenOhlc: vi.fn().mockResolvedValue({ candles: [], source: 'none' }),
      tokenOhlcToRugBars: () => [],
    }))

    const { captureSignalOhlcLabel } = await import('./signal-ohlc-labels')
    const id = await captureSignalOhlcLabel({
      tokenAddress: MINT,
      label: 'potential',
      source: 'mcap_label_backfill',
    })
    expect(id).toBeNull()
    expect(
      queryFn.mock.calls.some((c) => String(c[0]).includes('INSERT')),
    ).toBe(false)
  })

  it('soft-overwrites existing backfill_empty row when bars arrive', async () => {
    const updateSql: string[] = []
    vi.doMock('@/utils/db', () => ({
      query: vi.fn(async (sql: string) => {
        if (String(sql).includes('CREATE TABLE')) {
          return { rows: [], rowCount: 0 }
        }
        return { rows: [], rowCount: 0 }
      }),
      queryOne: vi.fn(async (sql: string) => {
        const s = String(sql)
        if (s.includes('SELECT id, bars, ohlc_source')) {
          return {
            id: 'row-empty',
            bars: [],
            ohlc_source: 'backfill_empty',
          }
        }
        if (s.includes('UPDATE signal_ohlc_labels')) {
          updateSql.push(s)
          return { id: 'row-empty' }
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
        candles: barCandles(),
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

    const { captureSignalOhlcLabel, isEmptySignalOhlcSlot } = await import(
      './signal-ohlc-labels'
    )
    expect(
      isEmptySignalOhlcSlot({ bars: [], ohlc_source: 'backfill_empty' }),
    ).toBe(true)

    const id = await captureSignalOhlcLabel({
      tokenAddress: MINT,
      label: 'potential',
      source: 'mcap_label_backfill',
    })
    expect(id).toBe('row-empty')
    expect(updateSql.length).toBe(1)
    expect(updateSql[0]).toContain('backfill_empty')
  })

  it('returns existing id when bars are already non-empty', async () => {
    vi.doMock('@/utils/db', () => ({
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      queryOne: vi.fn(async (sql: string) => {
        if (String(sql).includes('SELECT id, bars, ohlc_source')) {
          return {
            id: 'row-full',
            bars: [{ t: 1, o: 1, h: 1, l: 1, c: 1 }],
            ohlc_source: 'gmgn',
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
    const fetchTokenOhlc = vi.fn()
    vi.doMock('@/strategies/token-map-chart', () => ({
      getCachedTokenOhlc24h1m: vi.fn(),
      fetchTokenOhlc,
      tokenOhlcToRugBars: () => [],
    }))

    const { captureSignalOhlcLabel } = await import('./signal-ohlc-labels')
    const id = await captureSignalOhlcLabel({
      tokenAddress: MINT,
      label: 'rug',
    })
    expect(id).toBe('row-full')
    expect(fetchTokenOhlc).not.toHaveBeenCalled()
  })
})
