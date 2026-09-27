import { describe, expect, it, vi } from 'vitest'
import {
  buildSocialFomoNoulState,
  classifySocialFomoNoulBand,
  decisionFromBand,
  evaluateSocialFomoNoul,
  getSocialFomoNoulNo,
  getSocialFomoNoulYes,
  socialFomoNoulMode,
  socialFomoNoulShadowEnabled,
  socialFomoNoulSuppresses,
} from './social-fomo-noul-shadow'

const state = {
  chain: 'sol',
  mentions30m: 9,
  mentions24h: 12,
  uniqueChannels30m: 1,
  minutesSinceFirstMention: null,
  fomoBuyCount1h: 0,
  fomoEdge1h: null,
  mcap: 236_538,
  firstMcap: 31_992,
  mcapGrowthPct: 639,
  holdersPct: 21.5,
  organicScore: 46,
}

describe('social-fomo-noul-shadow bands', () => {
  it('classifies noul into suppress / mid / keep / api_miss', () => {
    expect(classifySocialFomoNoulBand(0.2)).toBe('suppress')
    expect(classifySocialFomoNoulBand(0.5)).toBe('mid')
    expect(classifySocialFomoNoulBand(0.9)).toBe('keep')
    expect(classifySocialFomoNoulBand(null)).toBe('api_miss')
  })

  it('mid and api_miss follow the code path', () => {
    expect(decisionFromBand('keep')).toBe('keep')
    expect(decisionFromBand('suppress')).toBe('suppress')
    expect(decisionFromBand('mid')).toBe('follow_spec')
    expect(decisionFromBand('api_miss')).toBe('follow_spec')
  })

  it('thresholds are env-tunable with defaults', () => {
    expect(getSocialFomoNoulNo({})).toBe(0.4)
    expect(getSocialFomoNoulYes({})).toBe(0.7)
    expect(getSocialFomoNoulNo({ SOCIAL_FOMO_NOUL_NO: '0.25' })).toBe(0.25)
  })

  it('mode defaults to shadow and the kill switch forces it', () => {
    expect(socialFomoNoulMode({})).toBe('shadow')
    expect(socialFomoNoulMode({ SOCIAL_FOMO_NOUL_MODE: 'enforce' })).toBe('enforce')
    expect(
      socialFomoNoulMode({
        SOCIAL_FOMO_NOUL_MODE: 'enforce',
        SOCIAL_FOMO_NOUL_KILL_SWITCH: '1',
      }),
    ).toBe('shadow')
    expect(socialFomoNoulShadowEnabled({ SOCIAL_FOMO_NOUL_SHADOW: '0' })).toBe(false)
  })
})

describe('evaluateSocialFomoNoul', () => {
  const okCall = (noul: number) =>
    vi.fn(async () => ({ ok: true as const, noul, model: 'jev-latest' }))

  it('records the Jev verdict but never suppresses in shadow mode', async () => {
    const v = await evaluateSocialFomoNoul(state, {
      env: {},
      call: okCall(0.1),
    })
    expect(v).toMatchObject({ called: true, noul: 0.1, band: 'suppress', decision: 'suppress', mode: 'shadow' })
    expect(socialFomoNoulSuppresses(v)).toBe(false)
  })

  it('suppresses only when enforce', async () => {
    const v = await evaluateSocialFomoNoul(state, {
      env: { SOCIAL_FOMO_NOUL_MODE: 'enforce' },
      call: okCall(0.1),
    })
    expect(v.mode).toBe('enforce')
    expect(socialFomoNoulSuppresses(v)).toBe(true)
  })

  it('falls back to the code path when Noul soft-fails', async () => {
    const v = await evaluateSocialFomoNoul(state, {
      env: { SOCIAL_FOMO_NOUL_MODE: 'enforce' },
      call: vi.fn(async () => ({ ok: false as const, reason: 'timeout' as const })),
    })
    expect(v.band).toBe('api_miss')
    expect(v.decision).toBe('follow_spec')
    expect(socialFomoNoulSuppresses(v)).toBe(false)
  })

  it('falls back when the call throws', async () => {
    const v = await evaluateSocialFomoNoul(state, {
      env: { SOCIAL_FOMO_NOUL_MODE: 'enforce' },
      call: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    expect(v.decision).toBe('follow_spec')
    expect(socialFomoNoulSuppresses(v)).toBe(false)
  })

  it('skips the call entirely when shadow is disabled', async () => {
    const call = okCall(0.9)
    const v = await evaluateSocialFomoNoul(state, {
      env: { SOCIAL_FOMO_NOUL_SHADOW: '0' },
      call,
    })
    expect(call).not.toHaveBeenCalled()
    expect(v.called).toBe(false)
  })
})

describe('buildSocialFomoNoulState', () => {
  it('carries the burst and mcap context, no secrets', () => {
    const s = buildSocialFomoNoulState(state)
    expect(s).toEqual({
      chain: 'sol',
      mentions_30m: 9,
      mentions_24h: 12,
      unique_channels_30m: 1,
      minutes_since_first_mention: null,
      fomo_buy_count_1h: 0,
      fomo_edge_1h: null,
      mcap: 236_538,
      first_mcap: 31_992,
      mcap_growth_pct: 639,
      top_holders_pct: 21.5,
      organic_score: 46,
    })
    expect(Object.keys(s).some((k) => /key|token|secret/i.test(k))).toBe(false)
  })
})
