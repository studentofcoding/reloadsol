import { describe, expect, it, vi } from 'vitest'
import {
  SOCIAL_FOMO_CANDLES_QUESTION_KEY,
  SOCIAL_FOMO_ORGANIC_QUESTION_KEY,
  buildSocialFomoNoulState,
  classifySocialFomoNoulBand,
  combineSocialFomoNoulBands,
  decisionFromBand,
  evaluateSocialFomoNoul,
  getSocialFomoNoulCandlesYes,
  getSocialFomoNoulNo,
  getSocialFomoNoulYes,
  socialFomoNoulMode,
  socialFomoNoulShadowEnabled,
  socialFomoNoulSuppresses,
  type SocialFomoNoulStateInput,
} from './social-fomo-noul-shadow'

const state: SocialFomoNoulStateInput = {
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
  ohlcN: 10,
  ohlcSource: 'own-1m',
  ohlcDumpPct: 0.12,
  ohlcAvgUpperWick: 0.2,
  ohlcUpOnlyCount: 3,
}

const multiCall = (answers: Record<string, number | null>) =>
  vi.fn(
    async (
      _state: Record<string, unknown>,
      _questions: Array<{ questionKey: string }>,
    ) => ({ ok: true as const, model: 'jev-latest', answers }),
  )

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

  it('combines two arms in code: keep needs both, either suppress wins', () => {
    expect(combineSocialFomoNoulBands('keep', 'keep', true)).toBe('keep')
    expect(combineSocialFomoNoulBands('keep', 'mid', true)).toBe('mid')
    expect(combineSocialFomoNoulBands('keep', 'suppress', true)).toBe('suppress')
    expect(combineSocialFomoNoulBands('suppress', 'keep', true)).toBe('suppress')
    expect(combineSocialFomoNoulBands('mid', 'mid', true)).toBe('mid')
    // No candle data → the candle arm is undecided, so `keep` is impossible.
    expect(combineSocialFomoNoulBands('keep', 'keep', false)).toBe('mid')
    expect(combineSocialFomoNoulBands('suppress', 'keep', false)).toBe('suppress')
  })

  it('thresholds are env-tunable with defaults', () => {
    expect(getSocialFomoNoulNo({})).toBe(0.4)
    expect(getSocialFomoNoulYes({})).toBe(0.7)
    expect(getSocialFomoNoulCandlesYes({ SOCIAL_FOMO_NOUL_CANDLES_YES: '0.8' })).toBe(0.8)
    expect(getSocialFomoNoulNo({ SOCIAL_FOMO_NOUL_ORGANIC_NO: '0.25' })).toBe(0.25)
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
  it('keep requires both arms; organic keep + candles mid follows the code path', async () => {
    const keep = await evaluateSocialFomoNoul(state, {
      env: {},
      call: multiCall({
        [SOCIAL_FOMO_ORGANIC_QUESTION_KEY]: 0.9,
        [SOCIAL_FOMO_CANDLES_QUESTION_KEY]: 0.9,
      }),
    })
    expect(keep).toMatchObject({
      called: true,
      noul: 0.9,
      organic: 0.9,
      candles: 0.9,
      band: 'keep',
      decision: 'keep',
      mode: 'shadow',
    })
    expect(socialFomoNoulSuppresses(keep)).toBe(false)

    const midCandles = await evaluateSocialFomoNoul(state, {
      env: {},
      call: multiCall({
        [SOCIAL_FOMO_ORGANIC_QUESTION_KEY]: 0.9,
        [SOCIAL_FOMO_CANDLES_QUESTION_KEY]: 0.5,
      }),
    })
    expect(midCandles.band).toBe('mid')
    expect(midCandles.decision).toBe('follow_spec')
  })

  it('either arm suppressing wins', async () => {
    const organicSuppress = await evaluateSocialFomoNoul(state, {
      env: {},
      call: multiCall({
        [SOCIAL_FOMO_ORGANIC_QUESTION_KEY]: 0.1,
        [SOCIAL_FOMO_CANDLES_QUESTION_KEY]: 0.9,
      }),
    })
    expect(organicSuppress.band).toBe('suppress')
    expect(organicSuppress.noul).toBe(0.1)

    const candlesSuppress = await evaluateSocialFomoNoul(state, {
      env: {},
      call: multiCall({
        [SOCIAL_FOMO_ORGANIC_QUESTION_KEY]: 0.9,
        [SOCIAL_FOMO_CANDLES_QUESTION_KEY]: 0.1,
      }),
    })
    expect(candlesSuppress.band).toBe('suppress')
  })

  it('asks only the organic question when there are no candles', async () => {
    const call = multiCall({ [SOCIAL_FOMO_ORGANIC_QUESTION_KEY]: 0.9 })
    const v = await evaluateSocialFomoNoul({ ...state, ohlcN: 0 }, { env: {}, call })
    const questions = call.mock.calls[0]![1]
    expect(questions.map((q) => q.questionKey)).toEqual([SOCIAL_FOMO_ORGANIC_QUESTION_KEY])
    expect(v.candles).toBeNull()
    expect(v.candlesBand).toBe('api_miss')
    // No candle arm → cannot keep; falls to the code path.
    expect(v.band).toBe('mid')
    expect(v.decision).toBe('follow_spec')
  })

  it('never suppresses in shadow mode, does in enforce', async () => {
    const answers = {
      [SOCIAL_FOMO_ORGANIC_QUESTION_KEY]: 0.1,
      [SOCIAL_FOMO_CANDLES_QUESTION_KEY]: 0.1,
    }
    const shadow = await evaluateSocialFomoNoul(state, { env: {}, call: multiCall(answers) })
    expect(shadow.decision).toBe('suppress')
    expect(socialFomoNoulSuppresses(shadow)).toBe(false)

    const enforce = await evaluateSocialFomoNoul(state, {
      env: { SOCIAL_FOMO_NOUL_MODE: 'enforce' },
      call: multiCall(answers),
    })
    expect(enforce.mode).toBe('enforce')
    expect(socialFomoNoulSuppresses(enforce)).toBe(true)
  })

  it('falls back to the code path when the call soft-fails or throws', async () => {
    const miss = await evaluateSocialFomoNoul(state, {
      env: { SOCIAL_FOMO_NOUL_MODE: 'enforce' },
      call: vi.fn(async () => ({ ok: false as const, reason: 'timeout' as const })),
    })
    expect(miss.band).toBe('api_miss')
    expect(miss.decision).toBe('follow_spec')
    expect(socialFomoNoulSuppresses(miss)).toBe(false)

    const boom = await evaluateSocialFomoNoul(state, {
      env: { SOCIAL_FOMO_NOUL_MODE: 'enforce' },
      call: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    expect(boom.band).toBe('api_miss')
    expect(socialFomoNoulSuppresses(boom)).toBe(false)
  })

  it('skips the call entirely when shadow is disabled', async () => {
    const call = multiCall({ [SOCIAL_FOMO_ORGANIC_QUESTION_KEY]: 0.9 })
    const v = await evaluateSocialFomoNoul(state, {
      env: { SOCIAL_FOMO_NOUL_SHADOW: '0' },
      call,
    })
    expect(call).not.toHaveBeenCalled()
    expect(v.called).toBe(false)
  })
})

describe('buildSocialFomoNoulState', () => {
  it('carries burst, mcap and candle context, no secrets', () => {
    const s = buildSocialFomoNoulState(state)
    expect(s).toMatchObject({
      chain: 'sol',
      mentions_30m: 9,
      unique_channels_30m: 1,
      top_holders_pct: 21.5,
      organic_score: 46,
      ohlc_n: 10,
      ohlc_source: 'own-1m',
      ohlc_dump_pct: 0.12,
      ohlc_up_only_count: 3,
    })
    expect(Object.keys(s).some((k) => /key|token|secret/i.test(k))).toBe(false)
  })

  it('defaults missing candle fields to null', () => {
    const s = buildSocialFomoNoulState({ ...state, ohlcN: undefined, ohlcSource: undefined })
    expect(s.ohlc_n).toBeNull()
    expect(s.ohlc_source).toBeNull()
    expect(s.ohlc_rug_trip).toBeNull()
  })
})
