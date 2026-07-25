import { describe, expect, it } from 'vitest'
import { wethWrapShortfall } from '@/utils/dlmm/rh-kyber-swap'

describe('wethWrapShortfall', () => {
  it('returns 0 when WETH covers need', () => {
    expect(wethWrapShortfall(BigInt(100), BigInt(100))).toBe(BigInt(0))
    expect(wethWrapShortfall(BigInt(50), BigInt(100))).toBe(BigInt(0))
  })

  it('returns shortfall only', () => {
    expect(wethWrapShortfall(BigInt(100), BigInt(40))).toBe(BigInt(60))
    expect(wethWrapShortfall(BigInt(10), BigInt(0))).toBe(BigInt(10))
  })
})
