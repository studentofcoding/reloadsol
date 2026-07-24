import { describe, expect, it } from 'vitest'
import { computeSingleSidedRange, ticksForPriceRatio } from './ticks'

describe('single-sided ticks', () => {
  it('converts a price ratio to ticks', () => {
    expect(ticksForPriceRatio(0.8)).toBeGreaterThan(2_000)
  })

  it('keeps token0 and token1 ranges outside market', () => {
    const token0 = computeSingleSidedRange({
      currentTick: 120,
      tickSpacing: 60,
      widthPercent: 20,
      depositIsToken0: true,
    })
    const token1 = computeSingleSidedRange({
      currentTick: 120,
      tickSpacing: 60,
      widthPercent: 20,
      depositIsToken0: false,
    })

    expect(token0.tickLower).toBeGreaterThan(120)
    expect(token1.tickUpper).toBeLessThanOrEqual(120)
  })
})
