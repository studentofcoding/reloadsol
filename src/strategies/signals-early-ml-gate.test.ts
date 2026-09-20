import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EARLY_ENTER_ML_MIN,
  getEarlyEnterMlMin,
  isEarlyEnterMlSoftGateEnabled,
  passesEarlyEnterMlSoftGate,
} from './signals-early-ml-gate'

describe('isEarlyEnterMlSoftGateEnabled', () => {
  it('defaults on when unset', () => {
    expect(isEarlyEnterMlSoftGateEnabled({})).toBe(true)
    expect(isEarlyEnterMlSoftGateEnabled({ EARLY_ENTER_ML_SOFT_GATE: '' })).toBe(true)
  })

  it('parses 1/true vs 0/false', () => {
    expect(isEarlyEnterMlSoftGateEnabled({ EARLY_ENTER_ML_SOFT_GATE: '1' })).toBe(true)
    expect(isEarlyEnterMlSoftGateEnabled({ EARLY_ENTER_ML_SOFT_GATE: 'true' })).toBe(true)
    expect(isEarlyEnterMlSoftGateEnabled({ EARLY_ENTER_ML_SOFT_GATE: '0' })).toBe(false)
    expect(isEarlyEnterMlSoftGateEnabled({ EARLY_ENTER_ML_SOFT_GATE: 'false' })).toBe(false)
  })
})

describe('getEarlyEnterMlMin', () => {
  it('defaults to 0.55 and accepts a finite override', () => {
    expect(getEarlyEnterMlMin({})).toBe(DEFAULT_EARLY_ENTER_ML_MIN)
    expect(getEarlyEnterMlMin({ EARLY_ENTER_ML_MIN: '0.6' })).toBe(0.6)
    expect(getEarlyEnterMlMin({ EARLY_ENTER_ML_MIN: 'nope' })).toBe(DEFAULT_EARLY_ENTER_ML_MIN)
  })
})

describe('passesEarlyEnterMlSoftGate', () => {
  it('passes at the 0.55 cut and suppresses just below', () => {
    expect(passesEarlyEnterMlSoftGate(0.55)).toBe(true)
    expect(passesEarlyEnterMlSoftGate(0.549)).toBe(false)
    expect(passesEarlyEnterMlSoftGate(0.7)).toBe(true)
  })

  it('treats null / non-finite as unavailable → suppress', () => {
    expect(passesEarlyEnterMlSoftGate(null)).toBe(false)
    expect(passesEarlyEnterMlSoftGate(undefined)).toBe(false)
    expect(passesEarlyEnterMlSoftGate(Number.NaN)).toBe(false)
    expect(passesEarlyEnterMlSoftGate(Number.POSITIVE_INFINITY)).toBe(false)
  })

  it('returns true when the flag is off (legacy emit)', () => {
    expect(passesEarlyEnterMlSoftGate(null, { enabled: false })).toBe(true)
    expect(passesEarlyEnterMlSoftGate(0.1, { enabled: false })).toBe(true)
  })
})
