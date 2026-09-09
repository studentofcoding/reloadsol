import { describe, expect, it } from 'vitest'
import { calculateWalletPnL } from './pnl-wallet'
import { buildRhBuyToken, buildRhSellToken } from './rh-trade-record'

/**
 * Pins the Robinhood path through the average-cost PnL engine: RH fill records
 * (built by rh-trade-record.ts with per-token priceUsd/tokenAmount) must feed
 * calculateWalletPnL exactly like Sol records do, so the daily pnl cron
 * (which scans trading_records across chains) realizes RH gains.
 */
describe('calculateWalletPnL with RH-shaped records', () => {
  it('realizes RH quote-mode sell PnL on top of a RH buy lot', () => {
    // USDG-quoted buy: spend 200 USDG at $1 each for 200 tokens → $1.00/token.
    const buy = buildRhBuyToken({
      mintAddress: '0x0000000000000000000000000000000000C0FFEE',
      symbol: 'TST',
      spentQuote: 200,
      usdPerUnit: 1,
      estOutRaw: '200000000', // 6-decimal token
      tokenDecimals: 6,
    })
    // USDG-quoted sell: 80 of the 200 tokens at $1.25 → realized $20.
    const sell = buildRhSellToken({
      mintAddress: '0x0000000000000000000000000000000000C0FFEE',
      symbol: 'TST',
      soldTokenAmount: 80,
      tokenPriceUsd: 1.25,
      receivedQuote: 100,
      usdPerUnit: 1,
    })

    const total = calculateWalletPnL([
      {
        data: { operationType: 'buy', tokens: [buy.token] },
      },
      {
        data: { operationType: 'sell', tokens: [sell.token] },
      },
    ])

    expect(buy.token.priceUsd).toBeCloseTo(1, 6)
    expect(sell.token.priceUsd).toBeCloseTo(1.25, 6)
    expect(total).toBeCloseTo(20, 6)
  })

  it('tracks a partial sell then a full close like the Sol flow', () => {
    const mint = '0x1111111111111111111111111111111111111111'
    const buy = buildRhBuyToken({
      mintAddress: mint,
      spentQuote: 100,
      usdPerUnit: 1,
      estOutRaw: '100000000',
      tokenDecimals: 6,
    })
    const partialSell = buildRhSellToken({
      mintAddress: mint,
      soldTokenAmount: 25,
      tokenPriceUsd: 2,
      receivedQuote: 50,
      usdPerUnit: 1,
    })
    const close = buildRhSellToken({
      mintAddress: mint,
      soldTokenAmount: 75,
      tokenPriceUsd: 0.5,
      receivedQuote: 37.5,
      usdPerUnit: 1,
    })

    const total = calculateWalletPnL([
      { data: { operationType: 'buy', tokens: [buy.token] } },
      { data: { operationType: 'sell', tokens: [partialSell.token] } },
      { data: { operationType: 'close', tokens: [close.token] } },
    ])

    // Partial: (2.00 - 1.00) * 25 = 25. Close: (0.50 - 1.00) * 75 = -37.5.
    expect(total).toBeCloseTo(-12.5, 6)
  })

  it('ignores RH records without price marks (no fake PnL)', () => {
    const total = calculateWalletPnL([
      {
        data: {
          operationType: 'buy',
          tokens: [{ mintAddress: '0x1', tokenAmount: 100 }],
        },
      },
      {
        data: {
          operationType: 'sell',
          tokens: [{ mintAddress: '0x1', tokenAmount: 100 }],
        },
      },
    ])
    expect(total).toBe(0)
  })
})
