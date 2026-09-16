import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MARKET_BRAIN_URL,
  fetchBrainJson,
  fetchBrainRecipe,
  fetchBrainRecipes,
  fetchBrainRegimeParams,
  fetchBrainUnion,
  isMarketBrainConfigured,
  isMarketBrainTrendingEnabled,
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
