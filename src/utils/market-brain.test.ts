import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MARKET_BRAIN_URL,
  fetchBrainJson,
  fetchBrainRecipe,
  fetchBrainRecipes,
  fetchBrainRegimeParams,
  fetchBrainUnion,
  isMarketBrainConfigured,
  isMarketBrainMcapEnabled,
  isMarketBrainSignalsEnabled,
  isMarketBrainTrendingEnabled,
  marketBrainMcapSkipReason,
  marketBrainSignalsSkipReason,
  marketBrainTrendingSkipReason,
  parseBrainListPayload,
  parseLegoRecipe,
  parseRegimeParams,
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
