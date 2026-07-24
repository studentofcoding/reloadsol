import { describe, expect, it } from 'vitest'
import type { LpTerminalPoolRaw } from '@/utils/dlmm/lp-terminal-pools'
import {
  RH_USDG,
  RH_WETH,
  applySlippageMinOut,
  getAmountOut,
  getRhRpcUrl,
  pickHighestTvlUniv2QuotePool,
  zapSplitQuote,
} from '@/utils/dlmm/rh-univ2'

const TOKEN = '0x1111111111111111111111111111111111111111'

function pool(
  partial: Partial<LpTerminalPoolRaw> & Pick<LpTerminalPoolRaw, 'address'>,
): LpTerminalPoolRaw {
  return {
    proto: 'univ2',
    token0: TOKEN,
    token1: RH_USDG,
    tvlUsd: 10_000,
    ...partial,
  }
}

describe('getRhRpcUrl', () => {
  it('defaults to ArrowRPC when RPC_4663 unset', () => {
    const prev = process.env.RPC_4663
    const prevPublic = process.env.NEXT_PUBLIC_RPC_4663
    delete process.env.RPC_4663
    delete process.env.NEXT_PUBLIC_RPC_4663
    try {
      expect(getRhRpcUrl()).toBe('https://rpc.arrowrpc.com')
    } finally {
      if (prev !== undefined) process.env.RPC_4663 = prev
      if (prevPublic !== undefined) process.env.NEXT_PUBLIC_RPC_4663 = prevPublic
    }
  })
})

describe('zapSplitQuote', () => {
  it('splits odd amounts without losing dust', () => {
    const { swapAmount, remainAmount } = zapSplitQuote(BigInt(101))
    expect(swapAmount).toBe(BigInt(50))
    expect(remainAmount).toBe(BigInt(51))
    expect(swapAmount + remainAmount).toBe(BigInt(101))
  })

  it('handles zero', () => {
    expect(zapSplitQuote(BigInt(0))).toEqual({ swapAmount: BigInt(0), remainAmount: BigInt(0) })
  })
})

describe('applySlippageMinOut', () => {
  it('applies 1% default', () => {
    expect(applySlippageMinOut(BigInt(10000), 100)).toBe(BigInt(9900))
  })
})

describe('getAmountOut', () => {
  it('matches univ2 fee math', () => {
    // amountIn=1000, reserveIn=100000, reserveOut=100000
    const out = getAmountOut(BigInt(1000), BigInt(100000), BigInt(100000))
    expect(out).toBe(BigInt(987))
  })
})

describe('pickHighestTvlUniv2QuotePool', () => {
  it('picks highest TVL among USDG/WETH univ2 pairs', () => {
    const pools = [
      pool({ address: '0xaa', token1: RH_USDG, tvlUsd: 5_000 }),
      pool({ address: '0xbb', token1: RH_WETH, tvlUsd: 50_000 }),
      pool({ address: '0xcc', token1: RH_USDG, tvlUsd: 20_000 }),
      {
        proto: 'univ3',
        address: '0xdd',
        token0: TOKEN,
        token1: RH_USDG,
        tvlUsd: 999_999,
      },
    ]
    const best = pickHighestTvlUniv2QuotePool(pools, TOKEN)
    expect(best?.pool.address).toBe('0xbb')
    expect(best?.quoteSymbol).toBe('WETH')
  })

  it('returns null when no quote pair', () => {
    const pools = [
      pool({
        address: '0xaa',
        token1: '0x2222222222222222222222222222222222222222',
        tvlUsd: 1,
      }),
    ]
    expect(pickHighestTvlUniv2QuotePool(pools, TOKEN)).toBeNull()
  })
})
