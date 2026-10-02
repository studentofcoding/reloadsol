import { describe, expect, it } from 'vitest'
import {
  MAX_TRADE_TOKENS,
  MAX_TRADE_TOKENS_RH,
  MAX_TRADE_TOKENS_SOL,
  buyMeetsMinUsdPerToken,
  buyMeetsMinUsdPerTokenOrPending,
  capTradeTokens,
  minBuyHumanAmount,
  minBuySliderPercent,
  maxTradeTokens,
} from '@/utils/trade-ui-limits'

describe('trade UI limits', () => {
  it('caps lists at 5', () => {
    expect(MAX_TRADE_TOKENS).toBe(5)
    expect(MAX_TRADE_TOKENS_RH).toBe(5)
    expect(MAX_TRADE_TOKENS_SOL).toBe(5)
    expect(maxTradeTokens('robinhood')).toBe(MAX_TRADE_TOKENS_RH)
    expect(maxTradeTokens('sol')).toBe(MAX_TRADE_TOKENS_SOL)
    expect(capTradeTokens([1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5])
    expect(capTradeTokens([1, 2])).toEqual([1, 2])
  })

  it('requires $0.50 per token after splitting the budget', () => {
    expect(buyMeetsMinUsdPerToken(0.01, 2, 2500)).toBe(true) // $12.50
    expect(buyMeetsMinUsdPerToken(0.002, 1, 2500)).toBe(true) // $5.00
    expect(buyMeetsMinUsdPerToken(0.0005, 1, 2500)).toBe(true) // $1.25 — passes at the lower minimum
    expect(buyMeetsMinUsdPerToken(0.0001, 1, 2500)).toBe(false) // $0.25
    expect(buyMeetsMinUsdPerToken(10, 2, 1)).toBe(true)
    expect(buyMeetsMinUsdPerToken(1, 2, 1)).toBe(true) // exactly $0.50 -> the predicate is >=
    expect(buyMeetsMinUsdPerToken(0.99, 2, 1)).toBe(false) // $0.495
    expect(buyMeetsMinUsdPerToken(5, 0, 1)).toBe(false)
  })

  it('pending min check passes while spot price is unknown', () => {
    expect(buyMeetsMinUsdPerTokenOrPending(0.01, 1, 0)).toBe(true)
    expect(buyMeetsMinUsdPerTokenOrPending(0, 1, 0)).toBe(false)
    expect(buyMeetsMinUsdPerTokenOrPending(0.0005, 1, 2500)).toBe(true) // $1.25
    expect(buyMeetsMinUsdPerTokenOrPending(0.0001, 1, 2500)).toBe(false) // $0.25
  })

  it('slider floor is $0.50 per token as a percent of balance', () => {
    expect(minBuyHumanAmount(1, 2500)).toBeCloseTo(0.0002)
    expect(minBuyHumanAmount(2, 1)).toBe(1)
    expect(minBuyHumanAmount(0, 1)).toBe(0.5)
    expect(minBuyHumanAmount(1, 0)).toBe(0)
    expect(minBuySliderPercent(100, 1, 1, 96)).toBe(1)
    expect(minBuySliderPercent(1, 1, 2500, 96)).toBe(1)
    expect(minBuySliderPercent(8, 1, 1, 96)).toBe(7)
    expect(minBuySliderPercent(4, 1, 1, 96)).toBe(13)
    expect(minBuySliderPercent(100, 1, 0, 96)).toBe(0)
    expect(minBuySliderPercent(0, 1, 1, 96)).toBe(0)
  })
})
