/**
 * Dual-sided zap amount planner (pure math — no network).
 * Splits a single-token deposit into amount0/amount1 for an in-range UniV3 position.
 */

import { TickMath } from './uniswap'

const Q96 = 2n ** 96n

function sqrtAtTick(tick: number): bigint {
  return BigInt(TickMath.getSqrtRatioAtTick(tick).toString())
}

/** UniV3 LiquidityAmounts.getAmount0ForLiquidity */
function amount0ForLiquidity(
  sqrtA: bigint,
  sqrtB: bigint,
  liquidity: bigint,
): bigint {
  let a = sqrtA
  let b = sqrtB
  if (a > b) [a, b] = [b, a]
  if (a === 0n) return 0n
  return ((liquidity * Q96 * (b - a)) / b) / a
}

/** UniV3 LiquidityAmounts.getAmount1ForLiquidity */
function amount1ForLiquidity(
  sqrtA: bigint,
  sqrtB: bigint,
  liquidity: bigint,
): bigint {
  let a = sqrtA
  let b = sqrtB
  if (a > b) [a, b] = [b, a]
  return (liquidity * (b - a)) / Q96
}

/** amount0/amount1 for liquidity L at current sqrtP inside [tickLower, tickUpper]. */
export function amountsForLiquidity(params: {
  liquidity: bigint
  sqrtPriceX96: bigint
  tickLower: number
  tickUpper: number
}): { amount0: bigint; amount1: bigint } {
  const { liquidity: L, sqrtPriceX96: sqrtP, tickLower, tickUpper } = params
  if (L <= 0n) return { amount0: 0n, amount1: 0n }
  const sqrtA = sqrtAtTick(tickLower)
  const sqrtB = sqrtAtTick(tickUpper)

  if (sqrtP <= sqrtA) {
    return { amount0: amount0ForLiquidity(sqrtA, sqrtB, L), amount1: 0n }
  }
  if (sqrtP >= sqrtB) {
    return { amount0: 0n, amount1: amount1ForLiquidity(sqrtA, sqrtB, L) }
  }
  return {
    amount0: amount0ForLiquidity(sqrtP, sqrtB, L),
    amount1: amount1ForLiquidity(sqrtA, sqrtP, L),
  }
}

/**
 * Max L such that amount0 + amount1-in-token0 ≤ depositAmount (deposit = token0).
 */
export function planZapFromToken0(params: {
  depositAmount: bigint
  sqrtPriceX96: bigint
  tickLower: number
  tickUpper: number
}): {
  amount0: bigint
  amount1: bigint
  keepToken0: bigint
  swapToken0For1: bigint
} {
  const { depositAmount, sqrtPriceX96, tickLower, tickUpper } = params
  if (depositAmount <= 0n) {
    return {
      amount0: 0n,
      amount1: 0n,
      keepToken0: 0n,
      swapToken0For1: 0n,
    }
  }

  // token1 per token0 ≈ (sqrtP / 2^96)^2 → amount1In0 = amount1 * 2^192 / sqrtP^2
  const sqrtP2 = sqrtPriceX96 * sqrtPriceX96

  let lo = 0n
  let hi = depositAmount // L often same order as token amounts for near-spot ranges
  // widen upper bound
  hi = depositAmount * 1_000_000n
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi + 1n) / 2n
    const { amount0, amount1 } = amountsForLiquidity({
      liquidity: mid,
      sqrtPriceX96,
      tickLower,
      tickUpper,
    })
    const amount1In0 = sqrtP2 > 0n ? (amount1 * Q96 * Q96) / sqrtP2 : 0n
    const cost = amount0 + amount1In0
    if (cost <= depositAmount) lo = mid
    else hi = mid - 1n
  }

  const { amount0, amount1 } = amountsForLiquidity({
    liquidity: lo,
    sqrtPriceX96,
    tickLower,
    tickUpper,
  })
  const keepToken0 = amount0
  const swapToken0For1 =
    depositAmount > keepToken0 ? depositAmount - keepToken0 : 0n
  return { amount0, amount1, keepToken0, swapToken0For1 }
}

/** Mirror when deposit is token1. */
export function planZapFromToken1(params: {
  depositAmount: bigint
  sqrtPriceX96: bigint
  tickLower: number
  tickUpper: number
}): {
  amount0: bigint
  amount1: bigint
  keepToken1: bigint
  swapToken1For0: bigint
} {
  const { depositAmount, sqrtPriceX96, tickLower, tickUpper } = params
  if (depositAmount <= 0n) {
    return {
      amount0: 0n,
      amount1: 0n,
      keepToken1: 0n,
      swapToken1For0: 0n,
    }
  }

  const sqrtP2 = sqrtPriceX96 * sqrtPriceX96
  let lo = 0n
  let hi = depositAmount * 1_000_000n
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi + 1n) / 2n
    const { amount0, amount1 } = amountsForLiquidity({
      liquidity: mid,
      sqrtPriceX96,
      tickLower,
      tickUpper,
    })
    const amount0In1 = sqrtP2 > 0n ? (amount0 * sqrtP2) / (Q96 * Q96) : 0n
    const cost = amount1 + amount0In1
    if (cost <= depositAmount) lo = mid
    else hi = mid - 1n
  }

  const { amount0, amount1 } = amountsForLiquidity({
    liquidity: lo,
    sqrtPriceX96,
    tickLower,
    tickUpper,
  })
  return {
    amount0,
    amount1,
    keepToken1: amount1,
    swapToken1For0: depositAmount > amount1 ? depositAmount - amount1 : 0n,
  }
}
