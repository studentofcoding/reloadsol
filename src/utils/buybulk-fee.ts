/**
 * Buy-bulk platform fee — **0.25% (25 bps)** on every swap.
 *
 * Solana execution path: Raptor `quote-and-swap` with this fee account / bps
 * (no custom on-chain program in this repo; that is the established buy_bulk
 * fee path). Robinhood execution path: BatchExecutor `FEE_BPS = 25`.
 *
 * Callers cannot lower or redirect the fee. `resolveBuybulkFeeBps` /
 * `resolveBuybulkSolFeeAccount` always return these canonical values.
 */
export const BUYBULK_PLATFORM_FEE_BPS = 25
export const BUYBULK_BPS_DENOM = 10_000

/** Percent of 100 used by `FEE_CONFIG` (0.25 → 0.25%). */
export const BUYBULK_PLATFORM_FEE_PERCENT = 0.25

/** Solana Raptor / Jupiter platform-fee recipient (dev treasury). */
export const BUYBULK_SOL_FEE_ACCOUNT =
  '3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX'

export const BUYBULK_PLATFORM_FEE_LABEL = '0.25% platform fee'

export function buybulkPlatformFeeAmount(amount: bigint): bigint {
  return (amount * BigInt(BUYBULK_PLATFORM_FEE_BPS)) / BigInt(BUYBULK_BPS_DENOM)
}

/** Always 25 bps — ignores requested values so clients cannot bypass. */
export function resolveBuybulkFeeBps(_requested?: number): number {
  return BUYBULK_PLATFORM_FEE_BPS
}

/** Always the buy_bulk Sol treasury — ignores requested accounts. */
export function resolveBuybulkSolFeeAccount(_requested?: string): string {
  return BUYBULK_SOL_FEE_ACCOUNT
}
