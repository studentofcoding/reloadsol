import { afterEach, describe, expect, it, vi } from 'vitest'

const NOW_SEC = 1_800_000_000

function candle(timeAgoSec: number) {
  return { time: NOW_SEC - timeAgoSec, open: 1, high: 1.1, low: 0.9, close: 1 }
}

async function load(opts: { cached: unknown[]; own: unknown[]; cachedSource?: string }) {
  vi.resetModules()
  vi.doMock('@/utils/db', () => ({ query: vi.fn(), queryOne: vi.fn() }))
  vi.doMock('@/strategies/token-map-chart', () => ({
    getCachedTokenOhlc24h1m: vi.fn(async () => ({
      candles: opts.cached,
      source: opts.cachedSource ?? 'gmgn',
    })),
    loadOwn1mBars: vi.fn(async () => opts.own),
    tokenOhlcToRugBars: (cs: Array<Record<string, number>>) =>
      cs.map((c) => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close })),
  }))
  return import('@/strategies/detect-snapshots')
}

describe('fetchLastOhlcRugBars recency', () => {
  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    delete process.env.OHLC_RUG_MAX_BAR_AGE_SEC
  })

  it('returns fresh canonical bars', async () => {
    const m = await load({ cached: [candle(120), candle(60), candle(10)], own: [] })
    const r = await m.fetchLastOhlcRugBars('mint', 10, { nowSec: NOW_SEC })
    expect(r.source).toBe('gmgn')
    expect(r.bars).toHaveLength(3)
  })

  it('returns stale/none when the canonical series is old', async () => {
    const m = await load({ cached: [candle(7200), candle(7140)], own: [] })
    const r = await m.fetchLastOhlcRugBars('mint', 10, { nowSec: NOW_SEC })
    expect(r).toEqual({ bars: [], source: 'stale' })
  })

  it('falls back to fresh own-1m when canonical is stale (Freeview)', async () => {
    const m = await load({ cached: [candle(7200)], own: [candle(40), candle(10)] })
    const r = await m.fetchLastOhlcRugBars('mint', 10, { nowSec: NOW_SEC, fallbackOwn1m: true })
    expect(r.source).toBe('own-1m')
    expect(r.bars).toHaveLength(2)
  })

  it('env OHLC_RUG_MAX_BAR_AGE_SEC tunes the window', async () => {
    process.env.OHLC_RUG_MAX_BAR_AGE_SEC = '1000'
    const m = await load({ cached: [candle(600)], own: [] })
    const r = await m.fetchLastOhlcRugBars('mint', 10, { nowSec: NOW_SEC })
    expect(r.bars).toHaveLength(1)
    process.env.OHLC_RUG_MAX_BAR_AGE_SEC = '0'
    const stale = await load({ cached: [candle(99999)], own: [] })
    expect((await stale.fetchLastOhlcRugBars('mint', 10, { nowSec: NOW_SEC })).bars).toHaveLength(1)
  })
})
