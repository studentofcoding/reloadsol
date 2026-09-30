import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetGmgnWebExtraForTests,
  fetchGmgnWebCandles,
  fetchGmgnWebSafety,
  fetchGmgnWebTokenStat,
  gmgnWebExtrasConfigured,
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
})
