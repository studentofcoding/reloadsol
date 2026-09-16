import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyBrainRiskToExit,
  createBrainRiskSession,
  frozenExitForSimOpen,
  localBrainRisk,
  pickActiveLegoRecipe,
  resetBrainRiskWarnForTests,
  resolveBrainRegimeRisk,
  riskCellFromGrid,
  scaleOpenSize,
  stampBrainRisk,
} from '@/utils/brain-regime-risk'
import { DEFAULT_MARKET_BRAIN_URL } from '@/utils/market-brain'
import type { LegoRecipe } from '@/utils/market-brain'
import { DEFAULT_LEGO_RISK_GRID } from '@/utils/brain-recipe-sync'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetBrainRiskWarnForTests()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const LIVE_RANGE = {
  profileId: 'default',
  state: 'Range' as const,
  sizeScale: 0.75,
  takeProfitPct: 15,
  stopLossPct: 10,
  holdHours: 12,
  climateFetchedAt: '2026-09-16T00:00:00.000Z',
}

const GRID_RECIPE: LegoRecipe = {
  id: 'mcap_enter_first_seen',
  active: true,
  domain: 'mcap',
  universe: ['union'],
  gates: [],
  profileId: 'default',
  riskGrid: DEFAULT_LEGO_RISK_GRID,
  raw: {},
}

function brainFetch(opts: {
  params?: unknown
  paramsStatus?: number
  recipes?: unknown
  recipesStatus?: number
}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const href = String(input)
    if (href.includes('/regime/params')) {
      if (opts.paramsStatus && opts.paramsStatus !== 200) {
        return jsonResponse({ error: 'upstream down' }, opts.paramsStatus)
      }
      return jsonResponse(opts.params ?? LIVE_RANGE)
    }
    if (href.includes('/recipes')) {
      if (opts.recipesStatus && opts.recipesStatus !== 200) {
        return jsonResponse({ error: 'recipes down' }, opts.recipesStatus)
      }
      return jsonResponse(opts.recipes ?? { recipes: [GRID_RECIPE] })
    }
    return jsonResponse({ error: 'unexpected' }, 404)
  })
}

describe('pickActiveLegoRecipe / riskCellFromGrid', () => {
  it('returns the exact active recipe and ignores inactive ids', () => {
    const dormant: LegoRecipe = { ...GRID_RECIPE, id: 'mcap_enter_at_80', active: false, dormant: true }
    expect(
      pickActiveLegoRecipe([GRID_RECIPE, dormant], { recipeId: 'mcap_enter_first_seen' })?.id,
    ).toBe('mcap_enter_first_seen')
    expect(pickActiveLegoRecipe([dormant], { recipeId: 'mcap_enter_at_80' })).toBeNull()
  })

  it('does not borrow another domain recipe when the strategy id is missing', () => {
    expect(
      pickActiveLegoRecipe([GRID_RECIPE], { recipeId: 'mcap_enter_at_80', domain: 'mcap' }),
    ).toBeNull()
  })

  it('looks up the embedded grid cell by climate state', () => {
    expect(riskCellFromGrid(GRID_RECIPE, 'Hype')).toMatchObject({
      sizeScale: 1,
      takeProfitPct: 20,
      holdHours: 24,
    })
    expect(riskCellFromGrid(GRID_RECIPE, 'Cash')?.sizeScale).toBe(0)
    expect(riskCellFromGrid(GRID_RECIPE, null)).toBeNull()
  })
})

describe('scaleOpenSize / applyBrainRiskToExit', () => {
  it('multiplies size and skips when sizeScale is 0', () => {
    const mixed = {
      ...localBrainRisk(),
      applied: true,
      source: 'live' as const,
      sizeScale: 0.5,
      standDown: false,
    }
    expect(scaleOpenSize(0.02, mixed)).toBe(0.01)

    const cash = {
      ...localBrainRisk(),
      applied: true,
      source: 'riskGrid' as const,
      sizeScale: 0,
      standDown: true,
    }
    expect(scaleOpenSize(0.02, cash)).toBe(0)
    expect(scaleOpenSize(0.02, localBrainRisk())).toBe(0.02)
  })

  it('applies TP / signed SL / hold and leaves null brain fields local', () => {
    const base = { stopLossPct: -50, takeProfitPct: 200, maxHoldHours: 96 }
    const risk = {
      ...localBrainRisk(),
      applied: true,
      source: 'live' as const,
      takeProfitPct: 15,
      stopLossPct: 10,
      holdHours: 12,
      sizeScale: 0.75,
    }
    expect(applyBrainRiskToExit(base, risk)).toEqual({
      stopLossPct: -10,
      takeProfitPct: 15,
      maxHoldHours: 12,
    })

    const partial = {
      ...risk,
      takeProfitPct: null,
      stopLossPct: null,
      holdHours: 8,
    }
    expect(applyBrainRiskToExit(base, partial).takeProfitPct).toBe(200)
    expect(applyBrainRiskToExit(base, partial).maxHoldHours).toBe(8)
    expect(applyBrainRiskToExit(base, localBrainRisk())).toEqual(base)
  })

  it('prefers overlay frozen exit, else brain-adjusted when applied', () => {
    const brainAdjusted = { stopLossPct: -10, takeProfitPct: 15, maxHoldHours: 12 }
    const overlay = { stopLossPct: -12, takeProfitPct: 18, maxHoldHours: 14 }
    const applied = { ...localBrainRisk(), applied: true, source: 'live' as const }
    expect(frozenExitForSimOpen(overlay, brainAdjusted, applied)).toEqual(overlay)
    expect(frozenExitForSimOpen(null, brainAdjusted, applied)).toEqual(brainAdjusted)
    expect(frozenExitForSimOpen(null, brainAdjusted, localBrainRisk())).toBeNull()
  })
})

describe('resolveBrainRegimeRisk', () => {
  it('prefers live GET /regime/params over embedded riskGrid', async () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', 't')
    vi.stubEnv('MARKET_BRAIN_MCAP', '')
    const fetchImpl = brainFetch({
      params: { ...LIVE_RANGE, sizeScale: 0.75, takeProfitPct: 15 },
      recipes: { recipes: [GRID_RECIPE] },
    })
    const result = await resolveBrainRegimeRisk({
      strategyId: 'mcap_enter_first_seen',
      domain: 'mcap',
      recipe: GRID_RECIPE,
      climateState: 'Hype',
      token: 't',
      fetchImpl,
    })
    expect(result.applied).toBe(true)
    expect(result.source).toBe('live')
    expect(result.sizeScale).toBe(0.75)
    expect(result.takeProfitPct).toBe(15)
    expect(result.state).toBe('Range')
    expect(scaleOpenSize(0.02, result)).toBe(0.015)
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      `${DEFAULT_MARKET_BRAIN_URL}/regime/params?profile=default`,
    )
  })

  it('falls back to recipe.riskGrid[state] when live params fail', async () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', 't')
    const fetchImpl = brainFetch({ paramsStatus: 503 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await resolveBrainRegimeRisk({
      strategyId: 'mcap_enter_first_seen',
      domain: 'mcap',
      recipe: GRID_RECIPE,
      climateState: 'Hype',
      token: 't',
      fetchImpl,
    })
    expect(result.applied).toBe(true)
    expect(result.source).toBe('riskGrid')
    expect(result.sizeScale).toBe(1)
    expect(result.takeProfitPct).toBe(20)
    expect(result.holdHours).toBe(24)
    expect(result.standDown).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('stand-down when the grid Cash cell has sizeScale 0', async () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', 't')
    const fetchImpl = brainFetch({ paramsStatus: 500 })
    const result = await resolveBrainRegimeRisk({
      strategyId: 'mcap_enter_first_seen',
      recipe: GRID_RECIPE,
      climateState: 'Cash',
      token: 't',
      fetchImpl,
    })
    expect(result.source).toBe('riskGrid')
    expect(result.standDown).toBe(true)
    expect(result.sizeScale).toBe(0)
    expect(scaleOpenSize(0.02, result)).toBe(0)
  })

  it('keeps local TP/SL/size and logs once when brain is unavailable', async () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', '')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = await resolveBrainRegimeRisk({
      strategyId: 'mcap_enter_first_seen',
      recipe: GRID_RECIPE,
      climateState: 'Range',
    })
    const second = await resolveBrainRegimeRisk({
      strategyId: 'signals_sell_over_100',
      recipe: GRID_RECIPE,
      climateState: 'Range',
    })
    expect(first).toMatchObject({ applied: false, source: 'local', standDown: false })
    expect(second.source).toBe('local')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/keeping local TP\/SL\/size/)
  })

  it('keeps local when live fails and there is no matching active recipe grid', async () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', 't')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = brainFetch({
      paramsStatus: 503,
      recipes: { recipes: [] },
    })
    const result = await resolveBrainRegimeRisk({
      strategyId: 'mcap_enter_first_seen',
      recipes: [],
      climateState: 'Range',
      token: 't',
      fetchImpl,
    })
    expect(result.applied).toBe(false)
    expect(result.source).toBe('local')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('applies live default-profile risk even when universe flags are off', async () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', 'read-token')
    vi.stubEnv('MARKET_BRAIN_MCAP', '')
    vi.stubEnv('MARKET_BRAIN_TRENDING', '')
    vi.stubEnv('MARKET_BRAIN_SIGNALS', '')
    const fetchImpl = brainFetch({
      params: { ...LIVE_RANGE, sizeScale: 0.25, takeProfitPct: 8, stopLossPct: 6, holdHours: 4 },
    })
    const result = await resolveBrainRegimeRisk({
      strategyId: 'mcap_enter_first_seen',
      domain: 'mcap',
      recipe: GRID_RECIPE,
      token: 'read-token',
      fetchImpl,
    })
    expect(result.applied).toBe(true)
    expect(result.source).toBe('live')
    expect(result.sizeScale).toBe(0.25)
    expect(result.standDown).toBe(false)
  })

  it('uses recipe.profileId on the live query string', async () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', 't')
    const recipe: LegoRecipe = { ...GRID_RECIPE, profileId: 'aggressive' }
    const fetchImpl = brainFetch({
      params: { ...LIVE_RANGE, profileId: 'aggressive' },
    })
    await resolveBrainRegimeRisk({
      strategyId: recipe.id,
      recipe,
      token: 't',
      fetchImpl,
    })
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      `${DEFAULT_MARKET_BRAIN_URL}/regime/params?profile=aggressive`,
    )
  })

  it('does not put the bearer token in fail-soft error text', async () => {
    const token = 'super-secret-brain-token'
    vi.stubEnv('MARKET_BRAIN_TOKEN', token)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401))
    const result = await resolveBrainRegimeRisk({
      strategyId: 'mcap_enter_first_seen',
      recipes: [],
      climateState: 'Range',
      token,
      fetchImpl,
    })
    expect(result.source).toBe('local')
    expect(result.reason).toMatch(/unauthorized/)
    expect(result.reason).not.toContain(token)
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(token)
  })
})

describe('createBrainRiskSession', () => {
  it('reuses /regime/params and recipes across strategy resolves', async () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', 't')
    const fetchImpl = brainFetch({
      recipes: {
        recipes: [
          GRID_RECIPE,
          { ...GRID_RECIPE, id: 'signals_sell_over_100', domain: 'signals' },
        ],
      },
    })
    const session = createBrainRiskSession({ token: 't', fetchImpl })
    const mcap = await session.resolve({ strategyId: 'mcap_enter_first_seen', domain: 'mcap' })
    const signals = await session.resolve({
      strategyId: 'signals_sell_over_100',
      domain: 'signals',
    })
    expect(mcap.source).toBe('live')
    expect(signals.source).toBe('live')
    const paths = fetchImpl.mock.calls.map((c) => String(c[0]))
    expect(paths.filter((p) => p.includes('/regime/params')).length).toBe(1)
    expect(paths.filter((p) => p.includes('/recipes')).length).toBe(1)
  })

  it('stamps audit fields onto entry features', () => {
    const stamped = stampBrainRisk(
      { entry_mcap: 80_000 },
      {
        ...localBrainRisk(),
        applied: true,
        source: 'live',
        state: 'Mixed',
        sizeScale: 0.5,
        recipeId: 'mcap_enter_first_seen',
      },
      { sizedSol: 0.01 },
    )
    expect(stamped).toMatchObject({
      entry_mcap: 80_000,
      brain_risk_source: 'live',
      brain_size_scale: 0.5,
      brain_risk_state: 'Mixed',
      brain_sized_sol: 0.01,
    })
  })
})
