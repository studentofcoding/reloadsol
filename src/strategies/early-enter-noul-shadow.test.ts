import { describe, expect, it } from 'vitest'
import {
  classifyNoulBand,
  decisionShadowFromBand,
  isEarlyEnterNoulShadowEnabled,
  isEarlyEnterNoulSoftActiveEnabled,
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
