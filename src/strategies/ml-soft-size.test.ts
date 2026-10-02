import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveMlSizeEnabled, softMlSize, stampMlSize } from './ml-soft-size'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('softMlSize', () => {
  it('is flat by default — the multiplier does not size (P1, 2026-10-01)', () => {
    expect(resolveMlSizeEnabled({})).toBe(false)
    // Whatever pBad is: the score was measured to have no rank power within or across strategies,
    // so it is out of the size path entirely.
    expect(softMlSize(0.04, { pBad: 0.5 })).toEqual({ sol: 0.04, mult: 1 })
    expect(softMlSize(0.04, { pBad: null })).toEqual({ sol: 0.04, mult: 1 })
    // The fail-soft inversion — a missing model earning the *largest* multiplier in the band — dies
    // with it, which is what made P2 (the guard) redundant once P1 shipped.
    expect(softMlSize(0.04, { pBad: 0 })).toEqual({ sol: 0.04, mult: 1 })
  })

  it('leaves a non-positive base alone rather than minting a stake', () => {
    expect(softMlSize(0, { pBad: 0.5 })).toEqual({ sol: 0, mult: 1 })
    expect(softMlSize(Number.NaN, { pBad: 0.5 })).toEqual({ sol: 0, mult: 1 })
  })

  it('keeps the legacy scaling reachable behind SOL_ML_SIZE_ENABLED for a soak', () => {
    vi.stubEnv('SOL_ML_SIZE_ENABLED', '1')
    expect(resolveMlSizeEnabled()).toBe(true)

    expect(softMlSize(0.04, { pBad: null })).toEqual({ sol: 0.04, mult: 1 })
    const half = softMlSize(1, { pBad: 0.5 })
    expect(half.mult).toBe(0.5)
    expect(half.sol).toBe(0.5)
    const floored = softMlSize(1, { pBad: 1 })
    expect(floored.mult).toBe(0.25)
    expect(floored.sol).toBe(0.25)
    const conf = softMlSize(1, { pBad: 0, confidence: 0 })
    expect(conf.mult).toBe(0.25)
  })
})

describe('stampMlSize', () => {
  it('writes ml_size_mult onto features', () => {
    const f = stampMlSize({ a: 1 }, { sol: 0.01, mult: 0.5 }, { pBad: 0.4 })
    expect(f).toMatchObject({ a: 1, ml_size_mult: 0.5, ml_p_bad: 0.4 })
  })
})
