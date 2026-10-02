import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  delete process.env.OHLC_SAMPLE_MAX_MINTS
  delete process.env.OHLC_SAMPLE_DETECT_WINDOW_MIN
})

async function load(rows: Array<{ token_address: string }> = []) {
  const query = vi.fn(async () => ({ rows }))
  vi.resetModules()
  vi.doMock('@/utils/db', () => ({ query }))
  const mod = await import('@/strategies/token-metrics-watch')
  return { mod, query }
}

describe('watch set — detected mints', () => {
  it('WATCH_SQL includes recent token_detect_snapshots via $5', async () => {
    const { mod } = await load()
    expect(mod.WATCH_SQL).toContain('FROM token_detect_snapshots')
    expect(mod.WATCH_SQL).toContain('make_interval(mins => $5::int)')
  })

  it('loadWatchMints passes the detect window (default 120) as $5', async () => {
    const { mod, query } = await load([{ token_address: 'A' }, { token_address: 'B' }])
    const mints = await mod.loadWatchMints({ maxMints: 10 })
    expect(mints).toEqual(['A', 'B'])
    const params = (query.mock.calls[0] as unknown[])[1] as unknown[]
    expect(params).toHaveLength(5)
    expect(params[2]).toBe(10)
    expect(params[4]).toBe(120)
    await mod.loadWatchMints({ detectWindowMin: 30 })
    expect(((query.mock.calls[1] as unknown[])[1] as unknown[])[4]).toBe(30)
  })
})

describe('sampler cap', () => {
  it('defaults to 500 (copier cap stays 300)', async () => {
    const { mod } = await load()
    expect(mod.resolveSamplerMaxMints()).toBe(500)
    expect(mod.DEFAULT_WATCH_MAX_MINTS).toBe(300)
  })

  it('env OHLC_SAMPLE_MAX_MINTS tunes it, clamped to the ceiling, junk → default', async () => {
    const { mod } = await load()
    process.env.OHLC_SAMPLE_MAX_MINTS = '800'
    expect(mod.resolveSamplerMaxMints()).toBe(800)
    process.env.OHLC_SAMPLE_MAX_MINTS = '999999'
    expect(mod.resolveSamplerMaxMints()).toBe(mod.SAMPLER_MAX_MINTS_CEILING)
    process.env.OHLC_SAMPLE_MAX_MINTS = 'nope'
    expect(mod.resolveSamplerMaxMints()).toBe(500)
  })

  it('env OHLC_SAMPLE_DETECT_WINDOW_MIN tunes the detect window', async () => {
    const { mod } = await load()
    expect(mod.resolveDetectWindowMin()).toBe(120)
    process.env.OHLC_SAMPLE_DETECT_WINDOW_MIN = '45'
    expect(mod.resolveDetectWindowMin()).toBe(45)
  })
})
