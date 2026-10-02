import { describe, expect, it } from 'vitest'
import { listLiveOpenBarPositions, visibleOpenBarPositions } from './open-bar-positions'
import type { TrackingRecord } from '@/utils/trading-tracker'
import type { OpenBarPosition } from './open-bar-positions'

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

  // A hold with no live buy record is not a position. The old fallback rendered the last such hold,
  // which is how an airdropped clone sharing a real token's ticker ("2 STONK") appeared in the bar.
  it('drops wallet holds with no live buy record', () => {
    const holdings = new Map([
      [
        'MintEarly',
        { balanceRaw: 10, uiAmount: 2, decimals: 6, symbol: 'EARLY' },
      ],
      [
        'MintLast',
        { balanceRaw: 20, uiAmount: 3, decimals: 6, symbol: 'LAST' },
      ],
    ])
    expect(listLiveOpenBarPositions([], holdings)).toEqual([])
  })

  it('skips quote mints and dust even when a buy record exists', () => {
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    const holdings = new Map([
      [
        usdc,
        { balanceRaw: 1_000_000, uiAmount: 1, decimals: 6, symbol: 'USDC' },
      ],
      [
        'MintDust',
        { balanceRaw: 1, uiAmount: 0.0000001, decimals: 6, symbol: 'DUST' },
      ],
    ])
    const open = listLiveOpenBarPositions(
      [buy(usdc, 0.05), buy('MintDust', 0.05)],
      holdings,
    )
    expect(open).toEqual([])
  })
})

describe('visibleOpenBarPositions', () => {
  const pos = (mint: string): OpenBarPosition => ({
    mintAddress: mint,
    symbol: 'TOK',
    logoURI: null,
    buyPriceUsd: 0.05,
    balanceRaw: 1_000_000,
    uiAmount: 1000,
    decimals: 6,
  })

  it('keeps a priced position and drops an unpriced one (the clone signature)', () => {
    const out = visibleOpenBarPositions([pos('Priced'), pos('Clone')], { Priced: 1.23 })
    expect(out.map((p) => p.mintAddress)).toEqual(['Priced'])
  })

  it('keeps a position through one missed poll', () => {
    const out = visibleOpenBarPositions([pos('Flicker')], {}, { Flicker: 9.99 })
    expect(out.map((p) => p.mintAddress)).toEqual(['Flicker'])
  })

  it('drops an unpriced position once the feed HAS answered without it', () => {
    const out = visibleOpenBarPositions(
      [pos('Gone'), pos('Other')],
      { Other: 1.5 },
      {},
    )
    expect(out.map((p) => p.mintAddress)).toEqual(['Other'])
  })

  it('fails open when the feed answered nothing at all, so an outage cannot empty the bar', () => {
    // Deliberate: an empty response means "we learned nothing", not "nothing has a price" — so a
    // pricing outage cannot hide every real position. The clone-hiding rule needs an answer.
    const all = [pos('A'), pos('B')]
    expect(visibleOpenBarPositions(all, {})).toEqual(all)
    expect(visibleOpenBarPositions(all, {}, {})).toEqual(all)
  })
})
