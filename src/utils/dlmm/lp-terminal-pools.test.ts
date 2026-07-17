import { describe, expect, it } from 'vitest'
import {
  feeAprPct,
  feeRateFromPpm,
  fees24hUsd,
  pairLabel,
  toPoolRows,
  type LpTerminalPoolRaw,
} from './lp-terminal-pools'

describe('lp-terminal-pools helpers', () => {
  it('derives fee rate and fees24h from ppm + volume', () => {
    expect(feeRateFromPpm(100)).toBeCloseTo(0.0001)
    expect(feeRateFromPpm(10_000)).toBeCloseTo(0.01)
    expect(fees24hUsd(1_000_000, 10_000)).toBeCloseTo(10_000)
  })

  it('computes fee APR', () => {
    // $10k fees/day on $1M TVL → 365%
    expect(feeAprPct(10_000, 1_000_000)).toBeCloseTo(365)
    expect(feeAprPct(100, 0)).toBeNull()
  })

  it('builds pair labels from token map', () => {
    const tokens = {
      '0xa': { address: '0xa', symbol: 'WETH', decimals: 18 },
      '0xb': { address: '0xb', symbol: 'USDG', decimals: 6 },
    }
    expect(pairLabel({ token0: '0xa', token1: '0xb' }, tokens)).toBe('WETH/USDG')
  })

  it('toPoolRows fills derived columns', () => {
    const pool: LpTerminalPoolRaw = {
      proto: 'univ3',
      address: '0xpool',
      token0: '0xa',
      token1: '0xb',
      feePpm: 10_000,
      tickSpacing: 200,
      reserve0: '1000000000000000000',
      reserve1: '2000000000',
      tvlUsd: 1_000_000,
      vol24hUsd: 1_000_000,
    }
    const rows = toPoolRows([pool], {
      '0xa': { address: '0xa', symbol: 'WETH', decimals: 18 },
      '0xb': { address: '0xb', symbol: 'USDG', decimals: 6 },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.pair).toBe('WETH/USDG')
    expect(rows[0]!.fees24hUsd).toBeCloseTo(10_000)
    expect(rows[0]!.feeAprPct).toBeCloseTo(365)
    expect(rows[0]!.protoLabel).toBe('UNI V3')
  })
})
