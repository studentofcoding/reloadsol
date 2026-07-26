import { describe, expect, it } from 'vitest'
import {
  computeDualSidedRange,
  computeSingleSidedRange,
  ticksForPriceRatio,
} from './ticks'
import { planZapFromToken0 } from './zap'

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

describe('dual-sided ticks', () => {
  it('keeps spot inside narrow range', () => {
    const r = computeDualSidedRange({
      currentTick: 0,
      tickSpacing: 60,
      minPct: -10,
      maxPct: 10,
    })
    expect(r.tickLower).toBeLessThan(0)
    expect(r.tickUpper).toBeGreaterThan(0)
  })
})

describe('zap planner', () => {
  it('splits token0 deposit into both sides in-range', () => {
    // sqrtPriceX96 at tick 0 = 2^96
    const sqrtP = 2n ** 96n
    const plan = planZapFromToken0({
      depositAmount: 10n ** 18n,
      sqrtPriceX96: sqrtP,
      tickLower: -600,
      tickUpper: 600,
    })
    expect(plan.amount0).toBeGreaterThan(0n)
    expect(plan.amount1).toBeGreaterThan(0n)
    expect(plan.keepToken0 + plan.swapToken0For1).toBe(10n ** 18n)
  })
})
