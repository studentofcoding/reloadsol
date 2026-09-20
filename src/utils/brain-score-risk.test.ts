import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyScoreRiskToExit,
  FALLBACK_DEFAULT_SOURCE,
  isPrincipalSimOpenStrategy,
  resolveScoreRiskForSimOpen,
  SCORE_OVERLAY_SOURCE,
  stampScoreRisk,
} from '@/utils/brain-score-risk'
import type { CombinedScoreResponse } from '@/strategies/combined-score'
import { DEFAULT_MCAP_TRACKER_EXIT } from '@/strategies/registry'
import type { BrainRiskFromScoreResolved } from '@/utils/market-brain'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const FALLBACK = { ...DEFAULT_MCAP_TRACKER_EXIT }

const SCORE: Pick<CombinedScoreResponse, 'combined' | 'rugTrip'> = {
  combined: 0.62,
  rugTrip: false,
}

const BRAIN_RISK: BrainRiskFromScoreResolved = {
  score: 0.62,
  profileId: 'default',
  climate: { state: 'Cash', sizeScale: 0.5 },
  risk: {
    takeProfitPct: 120,
    stopLossPct: -40,
    holdHours: 48,
    autoSl: false,
    source: SCORE_OVERLAY_SOURCE,
  },
  anchors: {
    deRisk: { takeProfitPct: 80, stopLossPct: -30, holdHours: 24 },
    hype: { takeProfitPct: 200, stopLossPct: -50, holdHours: 96 },
  },
  raw: {},
}

describe('isPrincipalSimOpenStrategy', () => {
  it('matches the two principal ids and their RH aliases', () => {
    expect(isPrincipalSimOpenStrategy('mcap_enter_first_seen')).toBe(true)
    expect(isPrincipalSimOpenStrategy('mcap_enter_at_80')).toBe(true)
    expect(isPrincipalSimOpenStrategy('mcap_enter_first_seen_rh')).toBe(true)
    expect(isPrincipalSimOpenStrategy('mcap_enter_at_80_rh')).toBe(true)
    expect(isPrincipalSimOpenStrategy('signals_sell_over_100')).toBe(false)
    expect(isPrincipalSimOpenStrategy('search_mcap_foo')).toBe(false)
  })
})

describe('applyScoreRiskToExit / stampScoreRisk', () => {
  it('overlays TP / signed SL / hold onto the fallback exit', () => {
    expect(
      applyScoreRiskToExit(FALLBACK, {
        takeProfitPct: 120,
        stopLossPct: -40,
        holdHours: 48,
      }),
    ).toEqual({
      takeProfitPct: 120,
      stopLossPct: -40,
      maxHoldHours: 48,
    })
  })

  it('signs a positive brain stop against a signed local fallback', () => {
    expect(
      applyScoreRiskToExit(FALLBACK, {
        takeProfitPct: 90,
        stopLossPct: 30,
        holdHours: 12,
      }).stopLossPct,
    ).toBe(-30)
  })

  it('stamps riskSource / combined / autoSl only after a brain attempt', () => {
    const skipped = stampScoreRisk(
      { entry_mcap: 80_000 },
      {
        called: false,
        applied: false,
        riskSource: FALLBACK_DEFAULT_SOURCE,
        combined: null,
        autoSl: false,
        exit: FALLBACK,
      },
    )
    expect(skipped).toEqual({ entry_mcap: 80_000 })

    const applied = stampScoreRisk(
      { entry_mcap: 80_000 },
      {
        called: true,
        applied: true,
        riskSource: SCORE_OVERLAY_SOURCE,
        combined: 0.62,
        autoSl: true,
        exit: FALLBACK,
      },
    )
    expect(applied).toMatchObject({
      entry_mcap: 80_000,
      riskSource: SCORE_OVERLAY_SOURCE,
      combined: 0.62,
      autoSl: true,
    })
  })
})

describe('resolveScoreRiskForSimOpen', () => {
  it('does not call the brain for non-principal strategies', async () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', 't')
    const fetchRisk = vi.fn()
    const result = await resolveScoreRiskForSimOpen({
      strategyId: 'signals_sell_over_100',
      mint: 'MintA',
      fallbackExit: FALLBACK,
      score: SCORE,
      fetchRisk,
    })
    expect(result.called).toBe(false)
    expect(result.exit).toEqual(FALLBACK)
    expect(fetchRisk).not.toHaveBeenCalled()
    expect(stampScoreRisk({}, result)).toEqual({})
  })

  it('flag off → no call even when a token is set', async () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', 't')
    vi.stubEnv('MARKET_BRAIN_SCORE_RISK', '0')
    const fetchRisk = vi.fn()
    const result = await resolveScoreRiskForSimOpen({
      strategyId: 'mcap_enter_first_seen',
      mint: 'MintA',
      fallbackExit: FALLBACK,
      score: SCORE,
      fetchRisk,
    })
    expect(result.called).toBe(false)
    expect(result.reason).toBe('flag_off')
    expect(fetchRisk).not.toHaveBeenCalled()
    expect(stampScoreRisk({ entry_mcap: 1 }, result)).toEqual({ entry_mcap: 1 })
  })

  it('applies brain TP/SL/hold and stamps score_overlay_v1 features', async () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', 't')
    const fetchRisk = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      data: { ...BRAIN_RISK, risk: { ...BRAIN_RISK.risk, autoSl: true } },
    }))
    const result = await resolveScoreRiskForSimOpen({
      strategyId: 'mcap_enter_at_80',
      mint: 'MintA',
      fallbackExit: FALLBACK,
      profileId: 'default',
      score: { combined: 0.2, rugTrip: true },
      fetchRisk,
    })
    expect(result.applied).toBe(true)
    expect(result.riskSource).toBe(SCORE_OVERLAY_SOURCE)
    expect(result.combined).toBe(0.2)
    expect(result.autoSl).toBe(true)
    expect(result.exit).toEqual({
      takeProfitPct: 120,
      stopLossPct: -40,
      maxHoldHours: 48,
    })
    expect(fetchRisk).toHaveBeenCalledWith(
      { score: 0.2, rugTrip: true, profile: 'default' },
      expect.objectContaining({ token: undefined }),
    )
    expect(stampScoreRisk({}, result)).toEqual({
      riskSource: SCORE_OVERLAY_SOURCE,
      combined: 0.2,
      autoSl: true,
    })
  })

  it('4xx / unreachable → DEFAULT / recipe fallback and riskSource=fallback_default', async () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', 't')
    const fetchRisk = vi.fn(async () => ({
      ok: false as const,
      status: 400,
      error: 'market-brain /risk/from-score: RISK_PROFILE_MISSING',
      path: '/risk/from-score',
    }))
    const recipeExit = { stopLossPct: -25, takeProfitPct: 80, maxHoldHours: 24 }
    const result = await resolveScoreRiskForSimOpen({
      strategyId: 'mcap_enter_first_seen',
      mint: 'MintA',
      fallbackExit: recipeExit,
      score: SCORE,
      fetchRisk,
    })
    expect(result.applied).toBe(false)
    expect(result.called).toBe(true)
    expect(result.riskSource).toBe(FALLBACK_DEFAULT_SOURCE)
    expect(result.exit).toEqual(recipeExit)
    expect(result.combined).toBe(0.62)
    expect(stampScoreRisk({}, result)).toMatchObject({
      riskSource: FALLBACK_DEFAULT_SOURCE,
      combined: 0.62,
      autoSl: false,
    })
  })

  it('loads combined score when one is not precomputed', async () => {
    vi.stubEnv('MARKET_BRAIN_TOKEN', 't')
    const loadCombinedScore = vi.fn(async () => ({
      success: true as const,
      mint: 'MintA',
      chain: 'sol' as const,
      hours: 24,
      combined: 0.55,
      weights: {
        principal: 0.55,
        adjusterPresence: 0.2,
        jaccard: 0.15,
        ohlcPattern: 0.1,
      },
      parts: {
        principalScore: 1,
        adjusterPresenceScore: 0,
        jaccardScore: null,
        ohlcPatternScore: 0.5,
      },
      principals: [],
      adjusters: [],
      rugTrip: false,
      generatedAt: '2026-09-20T00:00:00.000Z',
    }))
    const fetchRisk = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      data: BRAIN_RISK,
    }))
    const result = await resolveScoreRiskForSimOpen({
      strategyId: 'mcap_enter_first_seen',
      mint: 'MintA',
      chain: 'sol',
      fallbackExit: FALLBACK,
      loadCombinedScore,
      fetchRisk,
    })
    expect(loadCombinedScore).toHaveBeenCalledWith(
      expect.objectContaining({ address: 'MintA', chain: 'sol', hours: 24 }),
    )
    expect(result.combined).toBe(0.55)
    expect(result.applied).toBe(true)
  })
})
