import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LEGO_GATES,
  DEFAULT_LEGO_PROFILE_ID,
  DEFAULT_LEGO_RISK_GRID,
  DEFAULT_LEGO_UNIVERSE,
  dormantZeroTradeLegoRecipes,
  fatLegoRecipeForStrategy,
  knownWinnerRecipes,
  KNOWN_WINNER_STRATEGY_IDS,
  legoDomainForStrategy,
  legoRecipeActionForEvent,
  passesLegoPromoteGate,
  promoteLegoRecipe,
  seedKnownWinnerRecipes,
  syncLegoRecipe,
} from '@/utils/brain-recipe-sync'
import {
  DEFAULT_MARKET_BRAIN_URL,
  resetMarketBrainAdminWarnForTests,
} from '@/utils/market-brain'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetMarketBrainAdminWarnForTests()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('promote → recipe mapping', () => {
  it('maps SPEC events onto brain write actions', () => {
    expect(legoRecipeActionForEvent('promote')).toBe('upsert-activate')
    expect(legoRecipeActionForEvent('deactivate')).toBe('deactivate')
    expect(legoRecipeActionForEvent('dormant')).toBe('dormant')
    expect(legoRecipeActionForEvent('zero-trade')).toBe('dormant')
  })

  it('uses avgPnL>0 and n≥10 as the lego promote gate', () => {
    expect(passesLegoPromoteGate({ avgPnl: 1, n: 10 })).toBe(true)
    expect(passesLegoPromoteGate({ avgPnl: 0, n: 10 })).toBe(false)
    expect(passesLegoPromoteGate({ avgPnl: 5, n: 9 })).toBe(false)
  })

  it('maps first-cut strategy ids onto lego domains', () => {
    expect(legoDomainForStrategy('mcap_enter_first_seen')).toBe('mcap')
    expect(legoDomainForStrategy('mcap_enter_at_80', 'mcap_tracker')).toBe('mcap')
    expect(legoDomainForStrategy('signals_sell_over_100')).toBe('signals')
    expect(legoDomainForStrategy('att', 'trending_bot')).toBe('trending')
    expect(legoDomainForStrategy('gmgn_smartmoney_default', 'gmgn')).toBeNull()
  })

  it('builds a SPEC fat payload: union universe, default gates, no bmScore', () => {
    const recipe = fatLegoRecipeForStrategy({
      strategyId: 'mcap_enter_first_seen',
      active: true,
    })
    expect(recipe).toMatchObject({
      id: 'mcap_enter_first_seen',
      active: true,
      dormant: false,
      domain: 'mcap',
      universe: DEFAULT_LEGO_UNIVERSE,
      profileId: DEFAULT_LEGO_PROFILE_ID,
      riskGrid: DEFAULT_LEGO_RISK_GRID,
    })
    expect(recipe?.gates).toEqual(DEFAULT_LEGO_GATES)
    expect(recipe?.gates.map((g) => g.kind)).toEqual([
      'membership',
      'mcap',
      'liquidity',
      'climateSafe',
    ])
    expect(recipe?.gates.some((g) => g.kind === 'bmScore')).toBe(false)
  })

  it('seeds the three known winners as active recipes', () => {
    const seeded = knownWinnerRecipes()
    expect(seeded.map((r) => r.id)).toEqual([...KNOWN_WINNER_STRATEGY_IDS])
    expect(seeded.every((r) => r.active && r.dormant === false)).toBe(true)
    expect(seeded.map((r) => r.domain)).toEqual(['mcap', 'mcap', 'signals'])
  })
})

describe('promote/deactivate/dormant write client', () => {
  it('logs missing admin token once and does not throw on promote', async () => {
    vi.stubEnv('MARKET_BRAIN_ADMIN_TOKEN', '')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const first = await promoteLegoRecipe('mcap_enter_first_seen')
    const second = await promoteLegoRecipe('mcap_enter_at_80')
    expect(first.ok).toBe(false)
    expect(second.ok).toBe(false)
    if (first.ok || second.ok) throw new Error('expected failure')
    expect(first.error).toMatch(/MARKET_BRAIN_ADMIN_TOKEN is not set/)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/skipping recipe write/)
  })

  it('promote PUTs the fat recipe then POSTs /activate', async () => {
    const admin = 'admin-secret'
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url)
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ url: href, method, body })
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${admin}` })
      const recipe = {
        id: 'mcap_enter_first_seen',
        active: true,
        dormant: false,
        domain: 'mcap',
        universe: ['union'],
        gates: [{ kind: 'membership' }],
        profileId: 'default',
      }
      return jsonResponse({ ok: true, recipe })
    })

    const result = await promoteLegoRecipe('mcap_enter_first_seen', {
      adminToken: admin,
      fetchImpl,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      url: `${DEFAULT_MARKET_BRAIN_URL}/recipes/mcap_enter_first_seen`,
      method: 'PUT',
    })
    expect(calls[0]?.body).toMatchObject({
      id: 'mcap_enter_first_seen',
      active: true,
      dormant: false,
      domain: 'mcap',
      universe: ['union'],
      profileId: 'default',
    })
    expect(calls[0]?.body.gates.map((g: { kind: string }) => g.kind)).not.toContain('bmScore')
    expect(calls[1]).toMatchObject({
      url: `${DEFAULT_MARKET_BRAIN_URL}/recipes/mcap_enter_first_seen/activate`,
      method: 'POST',
    })
    expect(JSON.stringify(result)).not.toContain(admin)
  })

  it('deactivate and dormant POST the matching action (no hard-delete)', async () => {
    const admin = 'admin-secret'
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url)
      const recipe = {
        id: 'signals_sell_over_100',
        active: false,
        dormant: href.endsWith('/dormant'),
        domain: 'signals',
        universe: ['union'],
        profileId: 'default',
      }
      expect(init?.method).toBe('POST')
      return jsonResponse({ ok: true, recipe })
    })
    const deactivated = await syncLegoRecipe('signals_sell_over_100', 'deactivate', {
      adminToken: admin,
      fetchImpl,
    })
    const dormant = await syncLegoRecipe('signals_sell_over_100', 'zero-trade', {
      adminToken: admin,
      fetchImpl,
    })
    expect(deactivated.ok).toBe(true)
    expect(dormant.ok).toBe(true)
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      `${DEFAULT_MARKET_BRAIN_URL}/recipes/signals_sell_over_100/deactivate`,
    )
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(
      `${DEFAULT_MARKET_BRAIN_URL}/recipes/signals_sell_over_100/dormant`,
    )
  })

  it('seedKnownWinnerRecipes PUTs each winner as active', async () => {
    const ids: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('PUT')
      const body = JSON.parse(String(init?.body))
      ids.push(body.id)
      expect(body.active).toBe(true)
      expect(body.universe).toEqual(['union'])
      expect(body.profileId).toBe('default')
      expect(body.riskGrid.Hype.sizeScale).toBe(1)
      return jsonResponse({ ok: true, recipe: body })
    })
    const result = await seedKnownWinnerRecipes({ adminToken: 'admin', fetchImpl })
    expect(result.ok).toBe(true)
    expect(ids).toEqual([...KNOWN_WINNER_STRATEGY_IDS])
  })

  it('dormantZeroTradeLegoRecipes parks first-cut ids with n=0', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const id = String(url).split('/recipes/')[1]?.split('/')[0]
      return jsonResponse({
        ok: true,
        recipe: { id, active: false, dormant: true, domain: 'mcap', universe: ['union'] },
      })
    })
    const result = await dormantZeroTradeLegoRecipes({
      domain: 'mcap_tracker',
      closesByStrategy: new Map([
        ['mcap_enter_first_seen', 0],
        ['mcap_enter_at_80', 12],
      ]),
      opts: { adminToken: 'admin', fetchImpl },
    })
    expect(result).toEqual([{ id: 'mcap_enter_first_seen', ok: true }])
    expect(String(fetchImpl.mock.calls[0]?.[0])).toMatch(
      /\/recipes\/mcap_enter_first_seen\/dormant$/,
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('skips a just-promoted id even if it has zero closes', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, recipe: { id: 'x' } }))
    const result = await dormantZeroTradeLegoRecipes({
      domain: 'mcap_tracker',
      closesByStrategy: new Map(),
      skipIds: ['mcap_enter_first_seen', 'mcap_enter_at_80'],
      opts: { adminToken: 'admin', fetchImpl },
    })
    expect(result).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
