import { describe, expect, it } from 'vitest'
import {
  classifyNoulBand,
  decisionShadowFromBand,
  evaluateFlipBars,
  evaluateKillSwitchWindow,
  mergeKillSwitches,
  filterReasonFromBand,
  isEarlyEnterNoulShadowEnabled,
  isEarlyEnterNoulSoftActiveEnabled,
  isNoulShadowBand,
  resolveEarlyEnterNoulStrategyKey,
  shouldEmitWithNoulSoftActive,
  DEFAULT_NOUL_NO,
  DEFAULT_NOUL_YES,
} from './early-enter-noul-shadow'

describe('classifyNoulBand', () => {
  it('maps NO=0.2 YES=0.8 bands', () => {
    expect(classifyNoulBand(0.1)).toBe('suppress')
    expect(classifyNoulBand(DEFAULT_NOUL_NO)).toBe('suppress')
    expect(classifyNoulBand(0.5)).toBe('mid')
    expect(classifyNoulBand(DEFAULT_NOUL_YES)).toBe('keep')
    expect(classifyNoulBand(0.9)).toBe('keep')
  })

  it('api miss / non-finite → api_miss', () => {
    expect(classifyNoulBand(null, { apiMiss: true })).toBe('api_miss')
    expect(classifyNoulBand(null)).toBe('api_miss')
    expect(classifyNoulBand(Number.NaN)).toBe('api_miss')
  })

  it('decision_shadow: mid/api_miss/skipped_null → follow_spec', () => {
    expect(decisionShadowFromBand('keep')).toBe('keep')
    expect(decisionShadowFromBand('suppress')).toBe('suppress')
    expect(decisionShadowFromBand('mid')).toBe('follow_spec')
    expect(decisionShadowFromBand('api_miss')).toBe('follow_spec')
    expect(decisionShadowFromBand('skipped_null')).toBe('follow_spec')
  })
})

describe('resolveEarlyEnterNoulStrategyKey', () => {
  it('fog pick first_seen under 80 and at_80 at ≥80', () => {
    const active = ['mcap_enter_first_seen', 'mcap_enter_at_80']
    expect(
      resolveEarlyEnterNoulStrategyKey({
        chain: 'sol',
        growthPercent: 50,
        activeStrategyKeys: active,
      }),
    ).toBe('mcap_enter_first_seen')
    expect(
      resolveEarlyEnterNoulStrategyKey({
        chain: 'sol',
        growthPercent: 80,
        activeStrategyKeys: active,
      }),
    ).toBe('mcap_enter_at_80')
    expect(
      resolveEarlyEnterNoulStrategyKey({
        chain: 'sol',
        growthPercent: 99,
        activeStrategyKeys: active,
      }),
    ).toBe('mcap_enter_at_80')
  })

  it('uses _rh twins on robinhood', () => {
    expect(
      resolveEarlyEnterNoulStrategyKey({
        chain: 'robinhood',
        growthPercent: 40,
        activeStrategyKeys: ['mcap_enter_first_seen_rh', 'mcap_enter_at_80_rh'],
      }),
    ).toBe('mcap_enter_first_seen_rh')
  })

  it('returns null when locked arm not active (signals-only)', () => {
    expect(
      resolveEarlyEnterNoulStrategyKey({
        chain: 'sol',
        growthPercent: 50,
        activeStrategyKeys: ['signals_default'],
      }),
    ).toBeNull()
  })
})

describe('shouldEmitWithNoulSoftActive', () => {
  it('shadow mode (soft-active off): SPEC owns toast', () => {
    expect(
      shouldEmitWithNoulSoftActive({
        specWouldPass: true,
        softActive: false,
        band: 'suppress',
      }),
    ).toBe(true)
    expect(
      shouldEmitWithNoulSoftActive({
        specWouldPass: false,
        softActive: false,
        band: 'keep',
      }),
    ).toBe(false)
  })

  it('soft-active: keep/suppress drive; mid/api_miss follow SPEC', () => {
    expect(
      shouldEmitWithNoulSoftActive({
        specWouldPass: false,
        softActive: true,
        band: 'keep',
      }),
    ).toBe(true)
    expect(
      shouldEmitWithNoulSoftActive({
        specWouldPass: true,
        softActive: true,
        band: 'suppress',
      }),
    ).toBe(false)
    expect(
      shouldEmitWithNoulSoftActive({
        specWouldPass: true,
        softActive: true,
        band: 'mid',
      }),
    ).toBe(true)
    expect(
      shouldEmitWithNoulSoftActive({
        specWouldPass: false,
        softActive: true,
        band: 'api_miss',
      }),
    ).toBe(false)
  })
})

describe('noul flags', () => {
  it('shadow default on; soft-active default off; kill forces off', () => {
    expect(isEarlyEnterNoulShadowEnabled({} as NodeJS.ProcessEnv)).toBe(true)
    expect(isEarlyEnterNoulSoftActiveEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    expect(
      isEarlyEnterNoulSoftActiveEnabled({
        EARLY_ENTER_NOUL_SOFT_ACTIVE: '1',
        EARLY_ENTER_NOUL_KILL_SWITCH: '1',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(false)
    expect(
      isEarlyEnterNoulSoftActiveEnabled({
        EARLY_ENTER_NOUL_SOFT_ACTIVE: '1',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true)
  })
})

describe('isNoulShadowBand', () => {
  it('accepts locked band literals only', () => {
    expect(isNoulShadowBand('keep')).toBe(true)
    expect(isNoulShadowBand('suppress')).toBe(true)
    expect(isNoulShadowBand('mid')).toBe(true)
    expect(isNoulShadowBand('api_miss')).toBe(true)
    expect(isNoulShadowBand('skipped_null')).toBe(true)
    expect(isNoulShadowBand('follow_spec')).toBe(false)
    expect(isNoulShadowBand('')).toBe(false)
  })
})

describe('filterReasonFromBand', () => {
  it('maps skipped_null → null_ml; other bands pass through', () => {
    expect(filterReasonFromBand('skipped_null')).toBe('null_ml')
    expect(filterReasonFromBand('mid')).toBe('mid')
    expect(filterReasonFromBand('suppress')).toBe('suppress')
    expect(filterReasonFromBand('keep')).toBe('keep')
    expect(filterReasonFromBand('api_miss')).toBe('api_miss')
  })
})

describe('evaluateKillSwitchWindow (#54 api_miss)', () => {
  it('counts an api_miss rate spike separately from mid-band', () => {
    const quiet = evaluateKillSwitchWindow({
      total: 40,
      apiMiss: 2,
      agreementEligible: 30,
      agreementMatches: 28,
    })
    expect(quiet.apiMissRate).toBeCloseTo(0.05)
    expect(quiet.apiMissSpike).toBe(false)
    expect(quiet.tripped).toBe(false)

    const spike = evaluateKillSwitchWindow({
      total: 40,
      apiMiss: 5,
      agreementEligible: 30,
      agreementMatches: 28,
    })
    expect(spike.apiMissRate).toBeCloseTo(0.125)
    expect(spike.apiMissSpike).toBe(true)
    expect(spike.tripped).toBe(true)
  })

  it('does not trip on a tiny sample', () => {
    expect(
      evaluateKillSwitchWindow({
        total: 10,
        apiMiss: 10,
        agreementEligible: 0,
        agreementMatches: 0,
      }).tripped,
    ).toBe(false)
  })

  it('trips on a disagreement spike among keep/suppress rows', () => {
    const spike = evaluateKillSwitchWindow({
      total: 40,
      apiMiss: 0,
      agreementEligible: 20,
      agreementMatches: 16,
    })
    expect(spike.disagreementRate).toBeCloseTo(0.2)
    expect(spike.disagreementSpike).toBe(true)
    expect(spike.apiMissSpike).toBe(false)
  })

  it('merges a 24h api_miss spike onto a quiet all-time sample', () => {
    const allTime = evaluateKillSwitchWindow({
      total: 500,
      apiMiss: 10,
      agreementEligible: 400,
      agreementMatches: 380,
    })
    const recent = evaluateKillSwitchWindow({
      total: 40,
      apiMiss: 12,
      agreementEligible: 20,
      agreementMatches: 18,
    })
    const merged = mergeKillSwitches(allTime, recent)
    expect(allTime.tripped).toBe(false)
    expect(recent.apiMissSpike).toBe(true)
    expect(merged.tripped).toBe(true)
    expect(merged.apiMissRate).toBe(allTime.apiMissRate)
  })
})

describe('evaluateFlipBars (#54)', () => {
  it('requires N≥500, A≥85%, M≤20%', () => {
    expect(
      evaluateFlipBars({
        total: 500,
        agreementRate: 0.85,
        midBandRate: 0.2,
      }),
    ).toEqual({
      nOk: true,
      agreementOk: true,
      midOk: true,
      ready: true,
    })
    expect(
      evaluateFlipBars({
        total: 499,
        agreementRate: 0.9,
        midBandRate: 0.1,
      }).ready,
    ).toBe(false)
    expect(
      evaluateFlipBars({
        total: 600,
        agreementRate: 0.84,
        midBandRate: 0.1,
      }).agreementOk,
    ).toBe(false)
    expect(
      evaluateFlipBars({
        total: 600,
        agreementRate: 0.9,
        midBandRate: 0.21,
      }).midOk,
    ).toBe(false)
  })
})
