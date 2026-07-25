import { describe, expect, it } from 'vitest'
import { RH_USDG } from '@/utils/dlmm/rh-univ2'
import {
  KYBER_NATIVE,
  isKyberNative,
  kyberQuoteDecimals,
  kyberQuoteTokenAddress,
  toKyberAmountRaw,
} from '@/utils/kyber-aggregator'

describe('kyber-aggregator helpers', () => {
  it('maps quote currency to Kyber token addresses', () => {
    expect(kyberQuoteTokenAddress('ETH')).toBe(KYBER_NATIVE)
    expect(kyberQuoteTokenAddress('USDG').toLowerCase()).toBe(
      RH_USDG.toLowerCase(),
    )
    expect(isKyberNative(KYBER_NATIVE)).toBe(true)
    expect(isKyberNative(RH_USDG)).toBe(false)
  })

  it('encodes human amounts to raw units', () => {
    expect(kyberQuoteDecimals('ETH')).toBe(18)
    expect(kyberQuoteDecimals('USDG')).toBe(6)
    expect(toKyberAmountRaw(0.001, 18)).toBe('1000000000000000')
    expect(toKyberAmountRaw(10, 6)).toBe('10000000')
  })
})
