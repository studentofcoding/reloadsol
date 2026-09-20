import { describe, expect, it } from 'vitest'
import type { UserToken } from '@/utils/jupiter'
import {
  formatHoldingUsd,
  lookupHolding,
  mapUserTokensToHoldings,
  sumHeldCatchUsd,
} from './tracker-holdings'

function token(partial: Partial<UserToken>): UserToken {
  return {
    mintAddress: 'Mint1111111111111111111111111111111111111',
    balance: 0,
    decimals: 6,
    uiAmount: 0,
    usdValue: 0,
    ...partial,
  }
}

describe('mapUserTokensToHoldings', () => {
  it('maps held tokens to usd + amount and skips zero balance', () => {
    const map = mapUserTokensToHoldings([
      token({
        mintAddress: 'So11111111111111111111111111111111111111112',
        uiAmount: 2.5,
        usdValue: 12.34,
      }),
      token({
        mintAddress: 'ZeroMint111111111111111111111111111111111',
        uiAmount: 0,
        usdValue: 99,
      }),
    ])
    expect(map['so11111111111111111111111111111111111111112']).toEqual({
      usd: 12.34,
      amount: 2.5,
    })
    expect(map['zeromint111111111111111111111111111111111']).toBeUndefined()
  })

  it('looks up by case-insensitive mint', () => {
    const map = mapUserTokensToHoldings([
      token({
        mintAddress: '0xABCDef0000000000000000000000000000000001',
        uiAmount: 1,
        usdValue: 4,
      }),
    ])
    expect(lookupHolding(map, '0xabcdef0000000000000000000000000000000001')?.usd).toBe(4)
  })
})

describe('formatHoldingUsd', () => {
  it('formats currency with two decimals', () => {
    expect(formatHoldingUsd(12.34)).toBe('$12.34')
    expect(formatHoldingUsd(1000)).toBe('$1,000.00')
    expect(formatHoldingUsd(Number.NaN)).toBe('$0.00')
  })
})

describe('sumHeldCatchUsd', () => {
  it('counts and sums catch rows already held', () => {
    const holdings = mapUserTokensToHoldings([
      token({ mintAddress: 'a', uiAmount: 1, usdValue: 10 }),
      token({ mintAddress: 'b', uiAmount: 2, usdValue: 5.5 }),
    ])
    expect(sumHeldCatchUsd(['a', 'c'], holdings)).toEqual({ count: 1, usd: 10 })
    expect(sumHeldCatchUsd(['a', 'b'], holdings)).toEqual({ count: 2, usd: 15.5 })
  })
})
