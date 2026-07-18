import { describe, expect, it } from 'vitest'
import { parseGmgnTokenPriceUsd } from '@/utils/open-position-prices'

describe('parseGmgnTokenPriceUsd', () => {
  it('reads nested price.price string', () => {
    expect(
      parseGmgnTokenPriceUsd({
        price: { price: '0.001234' },
      }),
    ).toBeCloseTo(0.001234)
  })

  it('reads nested price.price number', () => {
    expect(parseGmgnTokenPriceUsd({ price: { price: 1.5 } })).toBe(1.5)
  })

  it('returns null for missing or zero', () => {
    expect(parseGmgnTokenPriceUsd({})).toBeNull()
    expect(parseGmgnTokenPriceUsd({ price: { price: 0 } })).toBeNull()
    expect(parseGmgnTokenPriceUsd({ price: { price: 'nope' } })).toBeNull()
  })
})
