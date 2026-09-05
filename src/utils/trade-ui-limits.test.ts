import { describe, expect, it } from 'vitest'
import {
  MAX_TRADE_TOKENS,
  buyMeetsMinUsdPerToken,
  capTradeTokens,
  minBuyHumanAmount,
  minBuySliderPercent,
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

  it('slider floor is $5 per token as a percent of balance', () => {
    expect(minBuyHumanAmount(1, 2500)).toBeCloseTo(0.002)
    expect(minBuyHumanAmount(2, 1)).toBe(10)
    expect(minBuyHumanAmount(0, 1)).toBe(5)
    expect(minBuySliderPercent(100, 1, 1, 96)).toBe(5)
    expect(minBuySliderPercent(1, 1, 2500, 96)).toBe(1)
    expect(minBuySliderPercent(8, 1, 1, 96)).toBe(63)
    expect(minBuySliderPercent(4, 1, 1, 96)).toBe(96)
    expect(minBuySliderPercent(100, 1, 0, 96)).toBe(0)
  })
})
