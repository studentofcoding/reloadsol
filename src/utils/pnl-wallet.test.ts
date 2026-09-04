import { describe, expect, it } from 'vitest'
import { calculateWalletPnL } from './pnl-wallet'

function rec(
  operationType: 'buy' | 'sell' | 'close',
  mintAddress: string,
  priceUsd: number,
  tokenAmount: number,
) {
  return {
    data: {
      operationType,
      tokens: [{ mintAddress, priceUsd, tokenAmount }],
    },
  }
}

describe('calculateWalletPnL', () => {
  it('uses weighted average cost across repeat buys', () => {
    const mint = 'mintA'
    expect(
      calculateWalletPnL([
        rec('buy', mint, 1, 10),
        rec('buy', mint, 3, 10),
        rec('sell', mint, 4, 20),
      ]),
    ).toBe(40)
  })

  it('does not reuse a fully sold lot on a later sell', () => {
    const mint = 'mintA'
    expect(
      calculateWalletPnL([
        rec('buy', mint, 1, 10),
        rec('sell', mint, 2, 10),
        rec('sell', mint, 5, 10),
      ]),
    ).toBe(10)
  })
})
