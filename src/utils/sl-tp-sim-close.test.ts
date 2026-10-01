import { describe, expect, it } from 'vitest'
import { simCloseDomainForStrategy } from './sl-tp-sim-close'
import { closeReasonForTrigger } from '@/strategies/close-strategy-sim-position'

describe('simCloseDomainForStrategy', () => {
  it('routes each family to the closer that owns it', () => {
    expect(simCloseDomainForStrategy('search_mcap_first_seen_sl_30_tp200_h48')).toBe('mcap')
    expect(simCloseDomainForStrategy('mcap_enter_at_80')).toBe('mcap')
    expect(simCloseDomainForStrategy('gmgn_sm_kol_combined')).toBe('gmgn')
    expect(simCloseDomainForStrategy('gmgn_kol_momentum')).toBe('gmgn')
    expect(simCloseDomainForStrategy('social_only_fomo_gt7')).toBe('social')
    expect(simCloseDomainForStrategy('search_signals_signals_score40_g0_default')).toBe('signals')
  })

  it('returns null for an unknown family rather than guessing a close path', () => {
    // Writing an outcome under the wrong domain is worse than leaving the row for its own closer.
    expect(simCloseDomainForStrategy('att_rh')).toBeNull()
    expect(simCloseDomainForStrategy('scalper')).toBeNull()
    expect(simCloseDomainForStrategy('')).toBeNull()
  })
})

describe('closeReasonForTrigger', () => {
  it('maps the worker trigger vocabulary onto the outcome vocabulary', () => {
    expect(closeReasonForTrigger('stop_loss')).toBe('stop_loss')
    expect(closeReasonForTrigger('take_profit_1')).toBe('take_profit')
    expect(closeReasonForTrigger('take_profit_2')).toBe('take_profit')
    expect(closeReasonForTrigger('take_profit_3')).toBe('take_profit')
    expect(closeReasonForTrigger('max_hold_time')).toBe('max_hold')
    expect(closeReasonForTrigger('max_age')).toBe('max_age')
    expect(closeReasonForTrigger('label_rugged')).toBe('label_rugged')
  })

  it('falls back to deactivation for an unrecognised trigger', () => {
    expect(closeReasonForTrigger('something_new')).toBe('strategy_deactivated')
  })
})
