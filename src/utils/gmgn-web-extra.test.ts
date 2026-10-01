import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetGmgnWebExtraForTests,
  fetchGmgnWebCandles,
  fetchGmgnWebCandlesPaced,
  fetchGmgnWebSafety,
  fetchGmgnWebTokenStat,
  gmgnWebCopyRps,
  gmgnWebExtrasConfigured,
  gmgnWebIsBlocked,
  normalizeGmgnWebResolution,
  takeGmgnWebBlockCount,
} from '@/utils/gmgn-web-extra'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

describe('gmgn-web-extra', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    __resetGmgnWebExtraForTests()
    vi.stubEnv('GMGN_WEB_HOST', 'https://worker.example')
    vi.stubEnv('GMGN_WEB_PROXY_SECRET', 's3cret')
    // Keep the shared min-interval gate ~0 so the tests do not sleep.
    vi.stubEnv('GMGN_WEB_MAX_POST_PER_SEC', '1000')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('is inert without GMGN_WEB_HOST (never burns a call at a Cloudflare 403)', async () => {
    vi.stubEnv('GMGN_WEB_HOST', '')
    expect(gmgnWebExtrasConfigured()).toBe(false)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(await fetchGmgnWebCandles('Mint', '1m')).toBeNull()
    expect(await fetchGmgnWebTokenStat('Mint')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('parses candles and normalises ms → seconds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        code: 0,
        data: {
          list: [
            { time: 1790751960000, open: '4480.1', high: '4500', low: '4400', close: '4490', volume: '12.5' },
            { time: 1790752020000, open: '4490', high: '4510', low: '4480', close: '4500' },
            { time: 'bad', open: '1', high: '1', low: '1', close: '1' },
          ],
        },
      }),
    )
    const candles = await fetchGmgnWebCandles('Mint', '1m')
    expect(candles).toHaveLength(2)
    expect(candles?.[0]).toMatchObject({ t: 1790751960, o: 4480.1, h: 4500, l: 4400, c: 4490, v: 12.5 })
    expect(candles?.[1].v).toBeUndefined()
  })

  it('requires a resolution and soft-fails on an upstream code', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(await fetchGmgnWebCandles('Mint', '')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()

    fetchSpy.mockResolvedValue(
      jsonResponse({ code: 40000300, reason: 'P_GMGN_IN_INVALID_ARGUMENT', data: null }),
    )
    expect(await fetchGmgnWebCandles('Mint', 'bogus')).toBeNull()
  })

  it('maps window resolutions the endpoint rejects onto supported ones', async () => {
    // Live: 6h and 24h return P_GMGN_IN_INVALID_ARGUMENT; 1h/4h/1d are accepted.
    expect(normalizeGmgnWebResolution('6h')).toBe('1h')
    expect(normalizeGmgnWebResolution('12h')).toBe('4h')
    expect(normalizeGmgnWebResolution('24h')).toBe('1d')
    expect(normalizeGmgnWebResolution('1m')).toBe('1m')
    expect(normalizeGmgnWebResolution('nope')).toBeNull()

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ code: 0, data: { list: [] } }))
    await fetchGmgnWebCandles('Mint', '6h')
    expect(String(fetchSpy.mock.calls[0][0])).toContain('resolution=1h')

    fetchSpy.mockClear()
    expect(await fetchGmgnWebCandles('Mint', 'weird')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('parses batch safety rows', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        code: 0,
        data: {
          list: [
            { token_address: 'A', liquidity: '2439116.48', is_honeypot: 'no', is_safe: 'yes' },
            { token_address: 'B', liquidity: '1', is_honeypot: 'yes', is_safe: 'no' },
          ],
        },
      }),
    )
    const rows = await fetchGmgnWebSafety(['A', 'B'])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ address: 'A', isHoneypot: false, isSafe: true })
    expect(rows[1]).toMatchObject({ address: 'B', isHoneypot: true, isSafe: false })
  })

  it('parses token_stat percentages with the 0–1 → percent rule', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        code: 0,
        data: {
          top_bundler_trader_percentage: '0.0094',
          top_rat_trader_percentage: '0',
          top_entrapment_trader_percentage: '0.2379',
          top_bot_degen_percentage: '30',
          private_vault_hold_rate: '0.5',
          top_10_holder_rate: '0.1236',
          creator_created_count: 6364,
        },
      }),
    )
    const stat = await fetchGmgnWebTokenStat('Mint')
    expect(stat?.bundlerPct).toBeCloseTo(0.94, 5)
    expect(stat?.ratPct).toBe(0)
    expect(stat?.entrapmentPct).toBeCloseTo(23.79, 4)
    expect(stat?.botDegenPct).toBe(30)
    expect(stat?.privateVaultPct).toBe(50)
    expect(stat?.top10Pct).toBeCloseTo(12.36, 4)
    expect(stat?.creatorCreatedCount).toBe(6364)
  })

  it('parks on 403 and stops calling upstream', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ error: 'blocked' }, 403))
    expect(await fetchGmgnWebTokenStat('Mint')).toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    // Second call is served from the negative cooldown — no upstream hit.
    expect(await fetchGmgnWebTokenStat('Other')).toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('counts 403/429 blocks and exposes the park state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 429))
    expect(await fetchGmgnWebTokenStat('Mint')).toBeNull()
    expect(gmgnWebIsBlocked()).toBe(true)
    expect(takeGmgnWebBlockCount()).toBe(1)
    // read-and-reset
    expect(takeGmgnWebBlockCount()).toBe(0)
  })

  it('paces the copy lane independently of the live lane', async () => {
    vi.stubEnv('GMGN_WEB_MAX_POST_PER_SEC', '1000') // live lane: ~1ms spacing
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ code: 0, data: { list: [] } }))

    const t0 = Date.now()
    for (let i = 0; i < 3; i++) {
      await fetchGmgnWebCandlesPaced('Mint', { resolution: '1m', limit: 501, rps: 20 })
    }
    const copyMs = Date.now() - t0

    const t1 = Date.now()
    for (let i = 0; i < 3; i++) await fetchGmgnWebTokenStat('Mint')
    const liveMs = Date.now() - t1

    // 20 rps → 50ms per gap, so 3 copy calls cannot finish before ~100ms…
    expect(copyMs).toBeGreaterThanOrEqual(80)
    // …while the live lane is not dragged along by the copy lane's spacing.
    expect(liveMs).toBeLessThan(60)
  })

  it('sends an explicit bar count on the copy lane, clamped to the upstream max', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ code: 0, data: { list: [] } }))

    await fetchGmgnWebCandlesPaced('Mint', { resolution: '1m', limit: 501, rps: 48 })
    expect(String(fetchSpy.mock.calls[0][0])).toContain('limit=501')

    fetchSpy.mockClear()
    await fetchGmgnWebCandlesPaced('Mint', { resolution: '1m', limit: 5000, rps: 48 })
    expect(String(fetchSpy.mock.calls[0][0])).toContain('limit=501')

    fetchSpy.mockClear()
    await fetchGmgnWebCandles('Mint', '1m')
    expect(String(fetchSpy.mock.calls[0][0])).not.toContain('limit=')
  })

  it('defaults the copy budget to the measured 80% and clamps nonsense', () => {
    expect(gmgnWebCopyRps()).toBe(48)
    vi.stubEnv('METRICS_COPY_RPS', '8')
    expect(gmgnWebCopyRps()).toBe(8)
    vi.stubEnv('METRICS_COPY_RPS', '5000')
    expect(gmgnWebCopyRps()).toBe(100)
    vi.stubEnv('METRICS_COPY_RPS', 'nope')
    expect(gmgnWebCopyRps()).toBe(48)
    vi.stubEnv('METRICS_COPY_RPS', '0')
    expect(gmgnWebCopyRps()).toBe(48)
  })
})
