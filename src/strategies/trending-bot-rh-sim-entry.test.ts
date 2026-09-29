import { describe, expect, it } from 'vitest'
import { openPositionsFor } from './trending-bot-rh-sim'
import type { TrackingRecord } from '@/utils/trading-tracker'

const STRATEGY = 'att_rh'
const MINT = 'mintReentry'

function simRecord(
  over: Partial<TrackingRecord> & { operationType: 'buy' | 'sell' },
): TrackingRecord {
  return {
    id: `${over.operationType}-${over.timestamp}`,
    walletAddress: 'trending-bot-rh-sim',
    is_simulation: true,
    simulation_type: 'strategy',
    successCount: 1,
    failureCount: 0,
    solAmount: 0.01,
    totalTokens: 1,
    feesPaid: 0,
    solPriceUsd: 3000,
    signatures: [],
    timestamp: 0,
    ...over,
    tokens: over.tokens ?? [
      { mintAddress: MINT, symbol: 'M', tokenAmount: 100, priceUsd: 0.001 },
    ],
  } as TrackingRecord
}

const buy = (timestamp: number, entryAt: string, tokenAmount = 100) =>
  simRecord({
    operationType: 'buy',
    bot_strategy: STRATEGY,
    timestamp,
    tokens: [{ mintAddress: MINT, symbol: 'M', tokenAmount, priceUsd: 0.001 }],
    trading_simulation: {
      entry_at: entryAt,
      entry_price_usd: 0.001,
      entry_features: { entry_mcap: 1000 },
    },
  })

const fullClose = (timestamp: number) =>
  simRecord({
    operationType: 'sell',
    bot_strategy: STRATEGY,
    timestamp,
    close_position: true,
  })

/**
 * Regression (att_rh): a mint that is closed and re-entered must report the
 * *current* cycle's entry. Stamping every trade with the mint's first-ever buy
 * made `(strategy, mint, entry_at)` collide across 77k distinct trades, so the
 * read-side dedupe collapsed them into a single outcome row.
 */
describe('openPositionsFor entry attribution', () => {
  it('uses the re-entry buy, not the mint first-ever buy', () => {
    const open = openPositionsFor(
      [buy(1_000, 'first-ever'), fullClose(2_000), buy(3_000, 're-entry')],
      STRATEGY,
    )
    expect(open.map((p) => p.mintAddress)).toEqual([MINT])
    expect(open[0].entryAt).toBe('re-entry')
  })

  it('keeps the opening buy when the position was only added to', () => {
    const open = openPositionsFor(
      [buy(1_000, 'opening'), buy(2_000, 'added', 50)],
      STRATEGY,
    )
    expect(open[0].entryAt).toBe('opening')
  })

  it('ignores a close that predates the opening buy of the current cycle', () => {
    const open = openPositionsFor(
      [
        buy(1_000, 'cycle-1'),
        fullClose(2_000),
        buy(3_000, 'cycle-2'),
        fullClose(4_000),
        buy(5_000, 'cycle-3'),
      ],
      STRATEGY,
    )
    expect(open[0].entryAt).toBe('cycle-3')
  })

  it('gives distinct entry stamps to two re-entries of the same mint', () => {
    const first = openPositionsFor(
      [buy(1_000, 'e1'), fullClose(2_000), buy(3_000, 'e2')],
      STRATEGY,
    )[0]
    const second = openPositionsFor(
      [buy(1_000, 'e1'), fullClose(2_000), buy(3_000, 'e2'), fullClose(4_000), buy(5_000, 'e3')],
      STRATEGY,
    )[0]
    expect(first.entryAt).not.toBe(second.entryAt)
  })
})
