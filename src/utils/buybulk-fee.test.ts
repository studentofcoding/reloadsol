import { describe, expect, it } from 'vitest'
import { RH_PLATFORM_FEE_BPS } from '@/utils/dlmm/rh-batch-executor'
import { RAPTOR_DEV_FEE_ACCOUNT, RAPTOR_DEV_FEE_BPS } from '@/utils/solanatracker-raptor'
import { getAllFeeRates, getFeeForOperation } from '@/utils/jupiter'
import {
  BUYBULK_PLATFORM_FEE_BPS,
  BUYBULK_PLATFORM_FEE_PERCENT,
  BUYBULK_SOL_FEE_ACCOUNT,
  buybulkPlatformFeeAmount,
  resolveBuybulkFeeBps,
  resolveBuybulkSolFeeAccount,
} from '@/utils/buybulk-fee'

describe('buy_bulk 25 bps platform fee', () => {
  it('is exactly 25 bps (0.25%)', () => {
    expect(BUYBULK_PLATFORM_FEE_BPS).toBe(25)
    expect(BUYBULK_PLATFORM_FEE_PERCENT).toBe(0.25)
    expect(buybulkPlatformFeeAmount(BigInt(10_000))).toBe(BigInt(25))
    expect(buybulkPlatformFeeAmount(BigInt(1_000_000_000))).toBe(BigInt(2_500_000))
  })

  it('floors like BatchExecutor: (amount * 25) / 10_000', () => {
    expect(buybulkPlatformFeeAmount(BigInt(1))).toBe(BigInt(0))
    expect(buybulkPlatformFeeAmount(BigInt(399))).toBe(BigInt(0))
    expect(buybulkPlatformFeeAmount(BigInt(400))).toBe(BigInt(1))
  })

  it('Sol Raptor and RH BatchExecutor share the same 25 bps', () => {
    expect(RAPTOR_DEV_FEE_BPS).toBe(BUYBULK_PLATFORM_FEE_BPS)
    expect(RH_PLATFORM_FEE_BPS).toBe(BUYBULK_PLATFORM_FEE_BPS)
    expect(RAPTOR_DEV_FEE_ACCOUNT).toBe(BUYBULK_SOL_FEE_ACCOUNT)
  })

  it('cannot be overridden by a caller-supplied bps or fee account', () => {
    expect(resolveBuybulkFeeBps(0)).toBe(25)
    expect(resolveBuybulkFeeBps(50)).toBe(25)
    expect(resolveBuybulkFeeBps(undefined)).toBe(25)
    expect(resolveBuybulkSolFeeAccount('11111111111111111111111111111111')).toBe(
      BUYBULK_SOL_FEE_ACCOUNT,
    )
    expect(resolveBuybulkSolFeeAccount(undefined)).toBe(BUYBULK_SOL_FEE_ACCOUNT)
  })

  it('jupiter FEE_CONFIG buy/sell percentages are 0.25%', () => {
    const rates = getAllFeeRates()
    expect(rates.buyPercentage).toBe(0.25)
    expect(rates.sellPercentage).toBe(0.25)
    expect(rates.devWallet).toBe(BUYBULK_SOL_FEE_ACCOUNT)
    expect(getFeeForOperation('BUY', 1)).toBeCloseTo(0.0025)
    expect(getFeeForOperation('SELL', 2)).toBeCloseTo(0.005)
  })
})
