import { describe, expect, it } from 'vitest'
import { listLiveOpenBarPositions } from './open-bar-positions'
import type { TrackingRecord } from '@/utils/trading-tracker'

const t0 = Date.parse('2026-09-01T00:00:00Z')

function buy(mint: string, priceUsd: number, tokenAmount = 1000): TrackingRecord {
  return {
    id: `b-${mint}`,
    walletAddress: 'w',
    operationType: 'buy',
    timestamp: t0,
    successCount: 1,
    failureCount: 0,
    totalTokens: 1,
    solAmount: 0.1,
    is_simulation: false,
    tokens: [
      {
        mintAddress: mint,
        symbol: 'TOK',
        tokenAmount,
        solAmount: 0.1,
        priceUsd,
        solPrice: 100,
      },
    ],
  } as TrackingRecord
}

describe('listLiveOpenBarPositions', () => {
  it('keeps live holds with cost basis and skips dust / sims / no-basis', () => {
    const mint = 'MintOpen111'
    const holdings = new Map([
      [
        mint,
        {
          balanceRaw: 1_000_000_000,
          uiAmount: 1000,
          decimals: 6,
          symbol: 'TOK',
        },
      ],
      [
        'MintDust',
        { balanceRaw: 1, uiAmount: 0.0000001, decimals: 6 },
      ],
    ])
    const records = [
      buy(mint, 0.05),
      {
        ...buy('MintSim', 0.1),
        is_simulation: true,
        id: 'sim',
      } as TrackingRecord,
    ]

    const open = listLiveOpenBarPositions(records, holdings)
    expect(open).toHaveLength(1)
    expect(open[0].mintAddress).toBe(mint)
    expect(open[0].buyPriceUsd).toBe(0.05)
    expect(open[0].uiAmount).toBe(1000)
  })

  it('appends the last untracked wallet hold and skips quote mints', () => {
    const holdings = new Map([
      [
        'MintEarly',
        { balanceRaw: 10, uiAmount: 2, decimals: 6, symbol: 'EARLY' },
      ],
      [
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        { balanceRaw: 1_000_000, uiAmount: 1, decimals: 6, symbol: 'USDC' },
      ],
      [
        'MintLast',
        { balanceRaw: 20, uiAmount: 3, decimals: 6, symbol: 'LAST' },
      ],
    ])
    const open = listLiveOpenBarPositions([], holdings)
    expect(open).toHaveLength(1)
    expect(open[0].mintAddress).toBe('MintLast')
    expect(open[0].untracked).toBe(true)
    expect(open[0].buyPriceUsd).toBe(0)
  })
})
