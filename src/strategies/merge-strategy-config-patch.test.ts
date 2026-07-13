import { describe, expect, it } from 'vitest'
import { mergeStrategyConfigPatch } from './merge-strategy-config-patch'

describe('mergeStrategyConfigPatch', () => {
  it('keeps existing when patch is omitted', () => {
    const existing = {
      buy_amount_sol: 0.05,
      take_profit_levels: { tp1_percentage: 40 },
    }
    expect(mergeStrategyConfigPatch(existing, undefined)).toEqual(existing)
  })

  it('merges partial patch without wiping siblings', () => {
    const existing = {
      buy_amount_sol: 0.05,
      stop_loss_percentage: -20,
      take_profit_levels: { tp1_percentage: 40, tp2_percentage: 80 },
      filtering: { enabled: true, mcap: { min: 10_000, max: 100_000 } },
    }
    const merged = mergeStrategyConfigPatch(existing, {
      buy_amount_sol: 0.1,
      take_profit_levels: { tp1_percentage: 55 },
      filtering: { mcap: { min: 20_000 } },
    })
    expect(merged.buy_amount_sol).toBe(0.1)
    expect(merged.stop_loss_percentage).toBe(-20)
    expect(merged.take_profit_levels).toEqual({
      tp1_percentage: 55,
      tp2_percentage: 80,
    })
    expect(merged.filtering).toEqual({
      enabled: true,
      mcap: { min: 20_000, max: 100_000 },
    })
  })

  it('treats empty existing as start from patch', () => {
    expect(
      mergeStrategyConfigPatch(null, { buy_amount_sol: 0.02 }),
    ).toEqual({ buy_amount_sol: 0.02 })
  })
})
