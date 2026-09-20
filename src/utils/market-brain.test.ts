import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MARKET_BRAIN_URL,
  brainOhlcSourceLabel,
  buildBrainOhlcQuery,
  fetchBrainJson,
  buildBrainRiskFromScoreQuery,
  fetchBrainOhlc,
  fetchBrainOhlcPatterns,
  fetchBrainRecipe,
  fetchBrainRecipes,
  fetchBrainRegimeParams,
  fetchBrainRiskFromScore,
  fetchBrainUnion,
  isMarketBrainConfigured,
  isMarketBrainMcapEnabled,
  isMarketBrainOhlcEnabled,
  isMarketBrainScoreRiskEnabled,
  isMarketBrainSignalsEnabled,
  isMarketBrainTrendingEnabled,
  marketBrainMcapSkipReason,
  marketBrainOhlcSkipReason,
  marketBrainScoreRiskSkipReason,
  marketBrainSignalsSkipReason,
  marketBrainTrendingSkipReason,
  parseBrainListPayload,
  parseBrainOhlcResponse,
  parseBrainRiskFromScore,
  parseLegoRecipe,
  parseRegimeParams,
  shouldFallbackBrainOhlc,
} from '@/utils/market-brain'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('market-brain config', () => {
  it('is unconfigured without a token and trending stays off', () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', '')
    vi.stubEnv('MARKET_BRAIN_TRENDING', '1')
    expect(isMarketBrainConfigured()).toBe(false)
    expect(isMarketBrainTrendingEnabled()).toBe(false)
    expect(marketBrainTrendingSkipReason()).toMatch(/MARKET_BRAIN_TOKEN is not set/)
  })

  it('enables trending only when flag and token are both set', () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', 'read-token')
    vi.stubEnv('MARKET_BRAIN_TRENDING', '1')
    expect(isMarketBrainConfigured()).toBe(true)
    expect(isMarketBrainTrendingEnabled()).toBe(true)
    expect(marketBrainTrendingSkipReason()).toBeNull()
  })

  it('enables mcap and signals plugs only when each flag and token are set', () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', '')
    vi.stubEnv('MARKET_BRAIN_MCAP', '1')
    vi.stubEnv('MARKET_BRAIN_SIGNALS', '1')
    expect(isMarketBrainMcapEnabled()).toBe(false)
    expect(marketBrainMcapSkipReason()).toMatch(/MARKET_BRAIN_TOKEN is not set/)
    expect(isMarketBrainSignalsEnabled()).toBe(false)
    expect(marketBrainSignalsSkipReason()).toMatch(/MARKET_BRAIN_TOKEN is not set/)

    vi.stubEnv('MARKET_BRAIN_TOKEN', 'read-token')
    expect(isMarketBrainMcapEnabled()).toBe(true)
    expect(marketBrainMcapSkipReason()).toBeNull()
    expect(isMarketBrainSignalsEnabled()).toBe(true)
    expect(marketBrainSignalsSkipReason()).toBeNull()
  })

  it('enables OHLC by default when a read token is set', () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', '')
    vi.stubEnv('MARKET_BRAIN_OHLC', '')
    expect(isMarketBrainOhlcEnabled()).toBe(false)
    expect(marketBrainOhlcSkipReason()).toBeNull()

    vi.stubEnv('MARKET_BRAIN_TOKEN', 'read-token')
    expect(isMarketBrainOhlcEnabled()).toBe(true)

    vi.stubEnv('MARKET_BRAIN_OHLC', '0')
    expect(isMarketBrainOhlcEnabled()).toBe(false)

    vi.stubEnv('MARKET_BRAIN_OHLC', '1')
    expect(isMarketBrainOhlcEnabled()).toBe(true)
  })

  it('reports OHLC skip reason only when the flag is explicit and token is missing', () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', '')
    vi.stubEnv('MARKET_BRAIN_OHLC', '1')
    expect(isMarketBrainOhlcEnabled()).toBe(false)
    expect(marketBrainOhlcSkipReason()).toMatch(/MARKET_BRAIN_TOKEN is not set/)
  })

  it('enables score-risk by default when a read token is set', () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', '')
    vi.stubEnv('MARKET_BRAIN_SCORE_RISK', '')
    expect(isMarketBrainScoreRiskEnabled()).toBe(false)
    expect(marketBrainScoreRiskSkipReason()).toBeNull()

    vi.stubEnv('MARKET_BRAIN_TOKEN', 'read-token')
    expect(isMarketBrainScoreRiskEnabled()).toBe(true)

    vi.stubEnv('MARKET_BRAIN_SCORE_RISK', '0')
    expect(isMarketBrainScoreRiskEnabled()).toBe(false)

    vi.stubEnv('MARKET_BRAIN_SCORE_RISK', '1')
    expect(isMarketBrainScoreRiskEnabled()).toBe(true)
  })

  it('accepts MARKET_BRAIN_READ_TOKEN as the read-token alias', () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', '')
    vi.stubEnv('MARKET_BRAIN_READ_TOKEN', 'alias-token')
    expect(isMarketBrainConfigured()).toBe(true)
    expect(isMarketBrainScoreRiskEnabled()).toBe(true)
  })
})

describe('parseBrainListPayload', () => {
  it('extracts mints from tokens[] and string mints[]', () => {
    const fromTokens = parseBrainListPayload('union', {
      generatedAt: '2026-09-16T00:00:00.000Z',
      tokens: [
        {
          mint: 'MintA',
          marketCap: 120_000,
          liquidity: 15_000,
          score100: 51,
        },
        { id: 'MintB', mcap: '90000', liq: 11_000 },
      ],
    })
    expect(fromTokens.mints).toEqual(['MintA', 'MintB'])
    expect(fromTokens.tokens[0]).toMatchObject({
      mint: 'MintA',
      marketCap: 120_000,
      liquidity: 15_000,
      score100: 51,
    })

    const fromMints = parseBrainListPayload('jupiter', { mints: ['MintC', 'MintC'] })
    expect(fromMints.mints).toEqual(['MintC'])
  })
})

describe('parseRegimeParams / parseLegoRecipe', () => {
  it('parses resolved regime cell', () => {
    const parsed = parseRegimeParams({
      profileId: 'default',
      state: 'Range',
      sizeScale: 0.75,
      takeProfitPct: 15,
      stopLossPct: 10,
      holdHours: 12,
      climateFetchedAt: '2026-09-16T00:00:00.000Z',
    })
    expect(parsed).toMatchObject({
      profileId: 'default',
      state: 'Range',
      sizeScale: 0.75,
      takeProfitPct: 15,
    })
  })

  it('parses a fat recipe object', () => {
    const recipe = parseLegoRecipe({
      id: 'trending_union_default',
      active: true,
      domain: 'trending',
      universe: ['union'],
      gates: [{ id: 'membership' }],
      profileId: 'default',
    })
    expect(recipe).toMatchObject({
      id: 'trending_union_default',
      active: true,
      domain: 'trending',
      universe: ['union'],
      profileId: 'default',
    })
  })
})

describe('fetchBrainJson fail-soft', () => {
  it('returns a clear error when the token is missing (no throw)', async () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', '')
    const result = await fetchBrainJson('/union')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toMatch(/MARKET_BRAIN_TOKEN is not set/)
  })

  it('does not put the bearer token in error text on HTTP 401', async () => {
    const token = 'super-secret-brain-token'
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`${DEFAULT_MARKET_BRAIN_URL}/union`)
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${token}`,
      })
      return jsonResponse({ error: 'unauthorized' }, 401)
    })
    const result = await fetchBrainJson('/union', { token, fetchImpl })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toMatch(/unauthorized/)
    expect(result.error).not.toContain(token)
    expect(result.status).toBe(401)
  })

  it('parses GET /union through fetchBrainUnion', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        tokens: [{ mint: 'MintA', marketCap: 70_000, liquidity: 12_000 }],
      }),
    )
    const result = await fetchBrainUnion({ token: 't', fetchImpl })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.mints).toEqual(['MintA'])
    expect(result.data.list).toBe('union')
  })

  it('fetches regime params with profile query', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(
        `${DEFAULT_MARKET_BRAIN_URL}/regime/params?profile=default`,
      )
      return jsonResponse({
        profileId: 'default',
        state: 'Mixed',
        sizeScale: 0.5,
        takeProfitPct: 12,
        stopLossPct: 8,
        holdHours: 8,
        climateFetchedAt: '2026-09-16T00:00:00.000Z',
      })
    })
    const result = await fetchBrainRegimeParams('default', { token: 't', fetchImpl })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.sizeScale).toBe(0.5)
    expect(result.data.state).toBe('Mixed')
  })

  it('fetches recipes list and by id', async () => {
    const recipe = {
      id: 'r1',
      active: true,
      domain: 'trending',
      universe: ['union'],
      gates: [],
      profileId: 'default',
    }
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.endsWith('/recipes')) return jsonResponse({ recipes: [recipe] })
      if (href.endsWith('/recipes/r1')) return jsonResponse(recipe)
      return jsonResponse({ error: 'not found' }, 404)
    })
    const list = await fetchBrainRecipes({ token: 't', fetchImpl })
    const one = await fetchBrainRecipe('r1', { token: 't', fetchImpl })
    expect(list.ok).toBe(true)
    expect(one.ok).toBe(true)
    if (!list.ok || !one.ok) throw new Error('expected ok')
    expect(list.data[0]?.id).toBe('r1')
    expect(one.data.id).toBe('r1')
  })
})

describe('brain OHLC client', () => {
  it('parses TokenOhlcBar-shaped candles and ms timestamps', () => {
    const parsed = parseBrainOhlcResponse({
      mint: 'MintA',
      chain: 'sol',
      interval: '1m',
      from: 1,
      to: 2,
      source: 'solanatracker',
      generatedAt: '2026-09-20T00:00:00.000Z',
      candles: [
        { time: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 9 },
        { t: 1_700_000_060, o: 1.5, h: 2, l: 1, c: 1.2 },
      ],
    })
    expect(parsed).toMatchObject({
      mint: 'MintA',
      chain: 'sol',
      interval: '1m',
      source: 'solanatracker',
    })
    expect(parsed?.candles).toEqual([
      { time: 1_700_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 9 },
      { time: 1_700_000_060, open: 1.5, high: 2, low: 1, close: 1.2 },
    ])
    expect(brainOhlcSourceLabel(parsed?.source)).toBe('brain:solanatracker')
  })

  it('builds hours vs from/to query strings', () => {
    expect(buildBrainOhlcQuery({ mint: 'MintA', chain: 'sol', interval: '1m', hours: 24 })).toBe(
      'mint=MintA&chain=sol&interval=1m&hours=24',
    )
    expect(
      buildBrainOhlcQuery({
        mint: 'MintA',
        interval: '1m',
        from: 10,
        to: 20,
        includePatterns: true,
      }),
    ).toBe('mint=MintA&interval=1m&from=10&to=20&include=patterns')
  })

  it('falls back on 5xx, timeout-shaped errors, and empty candles', () => {
    expect(
      shouldFallbackBrainOhlc({ ok: false, error: 'timeout', path: '/ohlc' }),
    ).toBe(true)
    expect(
      shouldFallbackBrainOhlc({
        ok: false,
        error: 'HTTP 502',
        status: 502,
        path: '/ohlc',
      }),
    ).toBe(true)
    expect(
      shouldFallbackBrainOhlc({
        ok: true,
        status: 200,
        data: { candles: [] },
      }),
    ).toBe(true)
    expect(
      shouldFallbackBrainOhlc({
        ok: true,
        status: 200,
        data: { candles: [{ time: 1 }] },
      }),
    ).toBe(false)
  })

  it('GETs /ohlc with bearer and parses candles', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        `${DEFAULT_MARKET_BRAIN_URL}/ohlc?mint=MintA&chain=sol&interval=1m&hours=24`,
      )
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer t' })
      return jsonResponse({
        mint: 'MintA',
        chain: 'sol',
        interval: '1m',
        source: 'cache',
        candles: [{ time: 10, open: 1, high: 1, low: 1, close: 1 }],
      })
    })
    const result = await fetchBrainOhlc(
      { mint: 'MintA', chain: 'sol', interval: '1m', hours: 24 },
      { token: 't', fetchImpl },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.candles).toHaveLength(1)
    expect(result.data.source).toBe('cache')
  })

  it('GETs /ohlc/patterns and maps rug features', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain('/ohlc/patterns?mint=MintA')
      return jsonResponse({
        rug: {
          trip: true,
          features: {
            n: 2,
            dumpPct: 0.5,
            avgUpperWick: 0.1,
            wickTripBars: 0,
            volDeathRatio: null,
          },
          hits: [
            {
              id: 'dump_10m',
              label: 'Dump',
              value: 0.5,
              threshold: 0.4,
              passed: true,
            },
          ],
        },
      })
    })
    const result = await fetchBrainOhlcPatterns({ mint: 'MintA' }, { token: 't', fetchImpl })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.rug.trip).toBe(true)
    expect(result.data.rug.features.dumpPct).toBe(0.5)
    expect(result.data.rug.hits[0]?.id).toBe('dump_10m')
  })

  it('does not put the bearer token in /ohlc error text', async () => {
    const token = 'super-secret-ohlc-token'
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401))
    const result = await fetchBrainOhlc({ mint: 'MintA' }, { token, fetchImpl })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toMatch(/unauthorized/)
    expect(result.error).not.toContain(token)
    expect(result.status).toBe(401)
  })
})

describe('market-brain GET /risk/from-score', () => {
  const payload = {
    ok: true,
    score: 0.62,
    profileId: 'default',
    climate: { state: 'Cash', sizeScale: 0.5 },
    risk: {
      takeProfitPct: 120,
      stopLossPct: -40,
      holdHours: 48,
      autoSl: false,
      source: 'score_overlay_v1',
    },
    anchors: {
      deRisk: { takeProfitPct: 80, stopLossPct: -30, holdHours: 24 },
      hype: { takeProfitPct: 200, stopLossPct: -50, holdHours: 96 },
    },
  }

  it('parses the SPEC contract payload', () => {
    const parsed = parseBrainRiskFromScore(payload)
    expect(parsed).toMatchObject({
      score: 0.62,
      profileId: 'default',
      climate: { state: 'Cash', sizeScale: 0.5 },
      risk: {
        takeProfitPct: 120,
        stopLossPct: -40,
        holdHours: 48,
        autoSl: false,
        source: 'score_overlay_v1',
      },
    })
    expect(parsed?.anchors.deRisk?.takeProfitPct).toBe(80)
  })

  it('builds score + rugTrip query strings', () => {
    expect(buildBrainRiskFromScoreQuery({ score: 0.62 })).toBe('score=0.62')
    expect(
      buildBrainRiskFromScoreQuery({ score: 0.2, rugTrip: true, profile: 'default' }),
    ).toBe('score=0.2&rugTrip=true&profile=default')
  })

  it('GETs /risk/from-score with bearer and parses knobs', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        `${DEFAULT_MARKET_BRAIN_URL}/risk/from-score?score=0.62&rugTrip=true`,
      )
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer t' })
      return jsonResponse(payload)
    })
    const result = await fetchBrainRiskFromScore(
      { score: 0.62, rugTrip: true },
      { token: 't', fetchImpl },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.risk.takeProfitPct).toBe(120)
    expect(result.data.risk.autoSl).toBe(false)
  })

  it('fails soft on 4xx without leaking the bearer token', async () => {
    const token = 'super-secret-score-risk-token'
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 'RISK_PROFILE_MISSING', error: 'RISK_PROFILE_MISSING' }, 400),
    )
    const result = await fetchBrainRiskFromScore({ score: 0.5 }, { token, fetchImpl })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.status).toBe(400)
    expect(result.error).toMatch(/RISK_PROFILE_MISSING/)
    expect(result.error).not.toContain(token)
  })
})

describe('market-brain admin writes', () => {
  it('fails soft when MARKET_BRAIN_ADMIN_TOKEN is missing', async () => {
    vi.stubEnv('MARKET_BRAIN_ADMIN_TOKEN', '')
    const { putBrainRecipe, isMarketBrainAdminConfigured } = await import('@/utils/market-brain')
    expect(isMarketBrainAdminConfigured()).toBe(false)
    const result = await putBrainRecipe({
      id: 'mcap_enter_first_seen',
      active: true,
      domain: 'mcap',
      universe: ['union'],
      gates: [{ kind: 'membership' }],
      profileId: 'default',
      riskGrid: {
        Cash: { sizeScale: 0, takeProfitPct: null, stopLossPct: null, holdHours: null },
        'De-risk': { sizeScale: 0.25, takeProfitPct: 8, stopLossPct: 6, holdHours: 4 },
        Mixed: { sizeScale: 0.5, takeProfitPct: 12, stopLossPct: 8, holdHours: 8 },
        Range: { sizeScale: 0.75, takeProfitPct: 15, stopLossPct: 10, holdHours: 12 },
        Hype: { sizeScale: 1, takeProfitPct: 20, stopLossPct: 12, holdHours: 24 },
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toMatch(/MARKET_BRAIN_ADMIN_TOKEN is not set/)
  })

  it('PUTs a recipe and POSTs activate/deactivate/dormant with the admin bearer', async () => {
    const admin = 'super-secret-admin-token'
    const recipe = {
      id: 'mcap_enter_first_seen',
      active: true,
      dormant: false,
      domain: 'mcap',
      universe: ['union'],
      gates: [{ kind: 'membership' }],
      profileId: 'default',
    }
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url)
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${admin}`,
      })
      if (init?.method === 'PUT' && href.endsWith('/recipes/mcap_enter_first_seen')) {
        expect(JSON.parse(String(init.body))).toMatchObject({ id: 'mcap_enter_first_seen', active: true })
        return jsonResponse({ ok: true, recipe })
      }
      if (init?.method === 'POST' && href.endsWith('/activate')) {
        return jsonResponse({ ok: true, recipe: { ...recipe, active: true, dormant: false } })
      }
      if (init?.method === 'POST' && href.endsWith('/deactivate')) {
        return jsonResponse({ ok: true, recipe: { ...recipe, active: false } })
      }
      if (init?.method === 'POST' && href.endsWith('/dormant')) {
        return jsonResponse({ ok: true, recipe: { ...recipe, active: false, dormant: true } })
      }
      return jsonResponse({ error: 'not found' }, 404)
    })
    const {
      putBrainRecipe,
      activateBrainRecipe,
      deactivateBrainRecipe,
      dormantBrainRecipe,
    } = await import('@/utils/market-brain')

    const put = await putBrainRecipe(
      {
        id: 'mcap_enter_first_seen',
        active: true,
        domain: 'mcap',
        universe: ['union'],
        gates: [{ kind: 'membership' }],
        profileId: 'default',
        riskGrid: {
          Cash: { sizeScale: 0, takeProfitPct: null, stopLossPct: null, holdHours: null },
          'De-risk': { sizeScale: 0.25, takeProfitPct: 8, stopLossPct: 6, holdHours: 4 },
          Mixed: { sizeScale: 0.5, takeProfitPct: 12, stopLossPct: 8, holdHours: 8 },
          Range: { sizeScale: 0.75, takeProfitPct: 15, stopLossPct: 10, holdHours: 12 },
          Hype: { sizeScale: 1, takeProfitPct: 20, stopLossPct: 12, holdHours: 24 },
        },
      },
      { adminToken: admin, fetchImpl },
    )
    const activated = await activateBrainRecipe('mcap_enter_first_seen', { adminToken: admin, fetchImpl })
    const deactivated = await deactivateBrainRecipe('mcap_enter_first_seen', {
      adminToken: admin,
      fetchImpl,
    })
    const dormant = await dormantBrainRecipe('mcap_enter_first_seen', { adminToken: admin, fetchImpl })

    expect(put.ok).toBe(true)
    expect(activated.ok).toBe(true)
    expect(deactivated.ok).toBe(true)
    expect(dormant.ok).toBe(true)
    if (!put.ok || !activated.ok || !deactivated.ok || !dormant.ok) throw new Error('expected ok')
    expect(put.data.id).toBe('mcap_enter_first_seen')
    expect(deactivated.data.active).toBe(false)
    expect(dormant.data.dormant).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    for (const result of [put, activated, deactivated, dormant]) {
      if (!result.ok) continue
      expect(JSON.stringify(result)).not.toContain(admin)
    }
  })

  it('does not put the admin token in error text on HTTP 401', async () => {
    const admin = 'super-secret-admin-token'
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401))
    const { activateBrainRecipe } = await import('@/utils/market-brain')
    const result = await activateBrainRecipe('mcap_enter_first_seen', { adminToken: admin, fetchImpl })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toMatch(/unauthorized/)
    expect(result.error).not.toContain(admin)
    expect(result.status).toBe(401)
  })
})
