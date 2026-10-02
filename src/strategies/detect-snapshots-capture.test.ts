import { afterEach, describe, expect, it, vi } from 'vitest'

describe('captureDetectSnapshot — own-1m fallback', () => {
  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('reads own-1m when the canonical 24h cache is empty, and persists those bars', async () => {
    vi.resetModules()
    const nowSec = Math.floor(Date.now() / 1000)
    const loadOwn1mBars = vi.fn(async () =>
      Array.from({ length: 4 }, (_, i) => ({
        time: nowSec - (3 - i) * 60,
        open: 1,
        high: 1.1,
        low: 0.9,
        close: 1,
      })),
    )
    const query = vi.fn(async (sql: string) =>
      sql.includes('INSERT INTO token_detect_snapshots')
        ? { rows: [{ id: 'snap-1' }] }
        : { rows: [] },
    )
    vi.doMock('@/utils/db', () => ({ query, queryOne: vi.fn() }))
    vi.doMock('@/strategies/token-map-chart', () => ({
      getCachedTokenOhlc24h1m: vi.fn(async () => ({ candles: [], source: 'none' })),
      loadOwn1mBars,
      tokenOhlcToRugBars: (cs: Array<Record<string, number>>) =>
        cs.map((c) => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close })),
    }))
    const { captureDetectSnapshot } = await import('@/strategies/detect-snapshots')
    const res = await captureDetectSnapshot({ tokenAddress: 'MintCap1', source: 'concentration' })
    expect(loadOwn1mBars).toHaveBeenCalledWith('MintCap1')
    expect(res.bars).toHaveLength(4)
    expect(res.snapshotId).toBe('snap-1')
    expect(res.evalResult.features.n).toBe(4)
  })
})
