import { describe, expect, it } from 'vitest'
import {
  applyBuyCostBasis,
  computeOpenTradeCycle,
  type OpenSimCycle,
} from './simulation-trades'
import type { TrackingRecord } from '@/utils/trading-tracker'

function liveBuy(
  mint: string,
  priceUsd: number,
  tokenAmount: number,
  solAmount: number,
  ts: number,
): TrackingRecord {
  return {
    id: `b-${ts}`,
    walletAddress: 'w',
    operationType: 'buy',
    timestamp: ts,
    successCount: 1,
    failureCount: 0,
    totalTokens: 1,
    solAmount,
    is_simulation: false,
    tokens: [
      {
        mintAddress: mint,
        symbol: 'JOLLY',
        tokenAmount,
        solAmount,
        priceUsd,
        solPrice: 100,
      },
    ],
  } as TrackingRecord
}

describe('applyBuyCostBasis', () => {
  it('weights by token amount across adds', () => {
    const cycle: OpenSimCycle = {
      mintAddress: 'm',
      remainingTokenAmount: 0,
      totalSolBought: 0,
      weightedBuyPriceUsd: 0,
    }
    applyBuyCostBasis(cycle, 33230.97, 0.00035289, 0.1)
    applyBuyCostBasis(cycle, 12613.68, 0.00055782, 0.06)
    const expected =
      (0.00035289 * 33230.97 + 0.00055782 * 12613.68) /
      (33230.97 + 12613.68)
    expect(cycle.weightedBuyPriceUsd).toBeCloseTo(expected, 10)
    expect(cycle.remainingTokenAmount).toBeCloseTo(45844.65, 2)
  })
})

describe('computeOpenTradeCycle', () => {
  it('does not use last-buy-only USD basis for live adds', () => {
    const mint = 'AouqdqhCsKb1x5Ngw5PktSonaWnxb9UiBF3QzBdvtMH'
    const cycle = computeOpenTradeCycle(
      [
        liveBuy(mint, 0.00035289, 33230.97, 0.1, 1),
        liveBuy(mint, 0.00055782, 12613.68, 0.06, 2),
      ],
      mint,
      'live',
    )
    expect(cycle).not.toBeNull()
    const expected =
      (0.00035289 * 33230.97 + 0.00055782 * 12613.68) /
      (33230.97 + 12613.68)
    expect(cycle!.weightedBuyPriceUsd).toBeCloseTo(expected, 10)
    // last-buy-only would be ~0.00055782 and mark ~0% near spot
    expect(cycle!.weightedBuyPriceUsd).toBeLessThan(0.0005)
  })
})
