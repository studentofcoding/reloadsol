import { describe, expect, it } from 'vitest'
import {
  MAX_TRADE_TOKENS,
  buyMeetsMinUsdPerToken,
  capTradeTokens,
} from '@/utils/trade-ui-limits'

describe('trade UI limits', () => {
  it('caps lists at 5', () => {
    expect(MAX_TRADE_TOKENS).toBe(5)
    expect(capTradeTokens([1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5])
    expect(capTradeTokens([1, 2])).toEqual([1, 2])
  })

  it('requires $5 per token after splitting the budget', () => {
    expect(buyMeetsMinUsdPerToken(0.01, 2, 2500)).toBe(true)
    expect(buyMeetsMinUsdPerToken(0.002, 1, 2500)).toBe(true)
    expect(buyMeetsMinUsdPerToken(0.001, 1, 2500)).toBe(false)
    expect(buyMeetsMinUsdPerToken(10, 2, 1)).toBe(true)
    expect(buyMeetsMinUsdPerToken(9, 2, 1)).toBe(false)
    expect(buyMeetsMinUsdPerToken(5, 0, 1)).toBe(false)
  })
})
