import { describe, expect, it } from 'vitest'
import { TOKENS } from '@/utils/solana'
import {
  TRACKER_BUY_DEFAULT_USD,
  defaultBuyAmountHuman,
  humanToRawAmount,
  percentOfRaw,
  pickTrackerBaseAsset,
  trackerTradeLeg,
} from '@/utils/tracker-base-asset'

const TOKEN = 'TokenMint111111111111111111111111111111111'

describe('pickTrackerBaseAsset', () => {
  it('uses USDC when its USD value is greater than SOL', () => {
    expect(
      pickTrackerBaseAsset({
        solUi: 0.4,
        solUsd: 40,
        usdcUi: 100,
        usdtUi: 0,
      }),
    ).toBe('USDC')
  })

  it('uses USDT when it is the dominant stable and beats SOL', () => {
    expect(
      pickTrackerBaseAsset({
        solUi: 0.5,
        solUsd: 50,
        usdcUi: 20,
        usdtUi: 80,
      }),
    ).toBe('USDT')
  })

  it('keeps SOL when SOL USD is at least the dominant stable', () => {
    expect(
      pickTrackerBaseAsset({
        solUi: 1,
        solUsd: 90,
        usdcUi: 20,
        usdtUi: 80,
      }),
    ).toBe('SOL')
    expect(
      pickTrackerBaseAsset({
        solUi: 1,
        solUsd: 100,
        usdcUi: 100,
        usdtUi: 0,
      }),
    ).toBe('SOL')
  })

  it('compares human balances when SOL USD is unavailable', () => {
    expect(
      pickTrackerBaseAsset({
        solUi: 1,
        solUsd: null,
        usdcUi: 5,
        usdtUi: 0,
      }),
    ).toBe('USDC')
    expect(
      pickTrackerBaseAsset({
        solUi: 2,
        solUsd: null,
        usdcUi: 0.5,
        usdtUi: 0,
      }),
    ).toBe('SOL')
  })

  it('defaults to SOL when every balance is empty', () => {
    expect(
      pickTrackerBaseAsset({
        solUi: 0,
        solUsd: 0,
        usdcUi: null,
        usdtUi: null,
      }),
    ).toBe('SOL')
  })
})

describe('defaultBuyAmountHuman', () => {
  it('defaults stables to $10 and SOL to $10 at the spot price', () => {
    expect(defaultBuyAmountHuman('USDC', 150)).toBe(String(TRACKER_BUY_DEFAULT_USD))
    expect(defaultBuyAmountHuman('USDT', null)).toBe('10')
    expect(defaultBuyAmountHuman('SOL', 100)).toBe('0.1')
    expect(defaultBuyAmountHuman('SOL', 200)).toBe('0.05')
    expect(defaultBuyAmountHuman('SOL', null)).toBe('')
  })
})

describe('trackerTradeLeg', () => {
  it('buys base → token and sells token → the same base', () => {
    const buy = trackerTradeLeg({
      side: 'buy',
      asset: 'USDC',
      tokenMint: TOKEN,
      buyHuman: 10,
    })
    expect(buy.inputMint).toBe(TOKENS.USDC)
    expect(buy.outputMint).toBe(TOKEN)
    expect(buy.amountRaw).toBe(10_000_000)

    const sell = trackerTradeLeg({
      side: 'sell',
      asset: 'USDC',
      tokenMint: TOKEN,
      sellBalanceRaw: 1_000,
      sellPercent: 100,
    })
    expect(sell.inputMint).toBe(TOKEN)
    expect(sell.outputMint).toBe(TOKENS.USDC)
    expect(sell.amountRaw).toBe(1_000)
    expect(percentOfRaw(999, 50)).toBe(499)
    expect(humanToRawAmount(0.1, 9)).toBe(100_000_000)
  })
})
