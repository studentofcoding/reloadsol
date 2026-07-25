import { describe, expect, it } from 'vitest'
import {
  computePriceImpactPct,
  quoteCurrencyUsdPerUnit,
  rawAmountToHuman,
} from '@/utils/rh-trade-sim'

describe('rh-trade-sim pure helpers', () => {
  it('prices USDG at $1 and ETH/WETH from ethUsd', () => {
    expect(quoteCurrencyUsdPerUnit('USDG', 3000)).toBe(1)
    expect(quoteCurrencyUsdPerUnit('ETH', 3000)).toBe(3000)
    expect(quoteCurrencyUsdPerUnit('WETH', 2500)).toBe(2500)
  })

  it('computes price impact percent', () => {
    expect(computePriceImpactPct(100, 97)).toBeCloseTo(3)
    expect(computePriceImpactPct(0, 10)).toBeNull()
  })

  it('decodes raw amounts', () => {
    expect(rawAmountToHuman('1000000', 6)).toBe(1)
    expect(rawAmountToHuman('1500000000000000000', 18)).toBe(1.5)
  })
})
