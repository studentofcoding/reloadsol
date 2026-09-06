import { describe, expect, it } from 'vitest'
import { softMlSize, stampMlSize } from './ml-soft-size'

describe('softMlSize', () => {
  it('passes through when pBad is missing', () => {
    expect(softMlSize(0.04, { pBad: null })).toEqual({ sol: 0.04, mult: 1 })
  })

  it('scales by (1-pBad) × confidence and never goes below the floor', () => {
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
