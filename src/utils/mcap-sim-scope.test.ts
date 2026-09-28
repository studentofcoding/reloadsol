import { describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

vi.mock('@/utils/unified-logger', () => ({
  log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { getOpenMcapSimPositions } from '@/utils/mcap-sim-track'
import { scopeRecordsToStrategy } from '@/utils/simulation-trades'
import type { TrackingRecord } from '@/utils/trading-tracker'

const MINT = 'mintSame'

function simRecord(over: Partial<TrackingRecord> & { operationType: 'buy' | 'sell' }): TrackingRecord {
  return {
    id: `${over.operationType}-${over.bot_strategy}-${over.timestamp}`,
    walletAddress: 'mcap-tracker-sim',
    is_simulation: true,
    simulation_type: 'strategy',
    successCount: 1,
    failureCount: 0,
    solAmount: 0.01,
    totalTokens: 1,
    feesPaid: 0,
    solPriceUsd: 200,
    signatures: [],
    timestamp: 0,
    ...over,
    tokens: over.tokens ?? [
      { mintAddress: MINT, symbol: 'SAME', tokenAmount: 100, priceUsd: 0.001 },
    ],
  } as TrackingRecord
}

describe('scopeRecordsToStrategy', () => {
  it('keeps only the strategy own records', () => {
    const records = [
      simRecord({ operationType: 'buy', bot_strategy: 'A', timestamp: 1 }),
      simRecord({ operationType: 'buy', bot_strategy: 'B', timestamp: 2 }),
    ]
    expect(scopeRecordsToStrategy(records, 'A').map((r) => r.bot_strategy)).toEqual(['A'])
  })

  it('passes everything through when no strategy is given', () => {
    const records = [simRecord({ operationType: 'buy', bot_strategy: 'A', timestamp: 1 })]
    expect(scopeRecordsToStrategy(records, null)).toBe(records)
  })
})

/**
 * Regression: a close must not consume another strategy's tokens for the same
 * mint. Two strategies bought the same mint; A closed. Under the old mint-wide
 * cycle A's close absorbed B's tokens, the aggregate went to zero, and B read as
 * closed — so B re-opened on every run (the FROINK/at_80 duplicate).
 */
describe('strategy-scoped open positions', () => {
  const records: TrackingRecord[] = [
    simRecord({ operationType: 'buy', bot_strategy: 'A', timestamp: 1_000 }),
    simRecord({
      operationType: 'buy',
      bot_strategy: 'B',
      timestamp: 2_000,
      tokens: [{ mintAddress: MINT, symbol: 'SAME', tokenAmount: 140, priceUsd: 0.001 }],
    }),
    simRecord({
      operationType: 'sell',
      bot_strategy: 'A',
      timestamp: 3_000,
      close_position: true,
      tokens: [{ mintAddress: MINT, symbol: 'SAME', tokenAmount: 100, priceUsd: 0.001 }],
    }),
  ]

  it('reports A closed after its own close', () => {
    expect(getOpenMcapSimPositions(records, 'A')).toEqual([])
  })

  it('still reports B open — its tokens were never sold', () => {
    const open = getOpenMcapSimPositions(records, 'B')
    expect(open.map((p) => p.mintAddress)).toEqual([MINT])
  })

  it('stops B from being re-openable while it holds the mint', () => {
    const openSet = new Set(getOpenMcapSimPositions(records, 'B').map((p) => p.mintAddress))
    expect(openSet.has(MINT)).toBe(true)
  })
})
