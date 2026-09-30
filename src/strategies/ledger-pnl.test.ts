import { describe, expect, it } from 'vitest'
import { summarizeLedger, summarizeLedgerPositions } from './ledger-pnl'
import type { TrackingRecord } from '@/utils/trading-tracker'

/**
 * Fixtures are built through one helper so every field the real ledger carries is present — the
 * shape matters here, because this module's whole point is reading what the ledger actually records.
 */
function record(over: {
  ts: number
  op: 'buy' | 'sell' | 'close'
  mint: string
  sol: number
  tokens?: number
  symbol?: string
  strategy?: string
  chain?: 'sol' | 'robinhood'
  successCount?: number
  amountSol?: number
  operationType?: string
}): TrackingRecord {
  const successCount = over.successCount ?? 1
  return {
    id: `r-${over.ts}-${over.op}`,
    walletAddress: 'sim-wallet',
    operationType: over.op,
    timestamp: over.ts,
    chain: over.chain ?? 'sol',
    tokens: [
      {
        mintAddress: over.mint,
        symbol: over.symbol ?? 'TOK',
        tokenAmount: over.tokens ?? 100,
        solAmount: over.sol,
      },
    ],
    successCount,
    failureCount: 0,
    totalTokens: 1,
    solAmount: over.amountSol ?? over.sol,
    bot_strategy: over.strategy ?? 'strat_a',
    is_simulation: true,
  } as unknown as TrackingRecord
}

describe('summarizeLedgerPositions', () => {
  it('pairs a buy with its close and reports the realized result', () => {
    const positions = summarizeLedgerPositions([
      record({ ts: 1_000, op: 'buy', mint: 'A', sol: 0.05, tokens: 100 }),
      record({ ts: 2_000, op: 'close', mint: 'A', sol: 0.08, tokens: 100 }),
    ])
    expect(positions).toHaveLength(1)
    expect(positions[0].costSol).toBeCloseTo(0.05, 8)
    expect(positions[0].proceedsSol).toBeCloseTo(0.08, 8)
    expect(positions[0].pnlSol).toBeCloseTo(0.03, 8)
    expect(positions[0].pnlPct).toBeCloseTo(60, 6)
    expect(positions[0].closed).toBe(true)
  })

  it('handles a partial sell before the close', () => {
    const positions = summarizeLedgerPositions([
      record({ ts: 1_000, op: 'buy', mint: 'A', sol: 0.05, tokens: 100 }),
      record({ ts: 1_500, op: 'sell', mint: 'A', sol: 0.03, tokens: 40 }),
      record({ ts: 2_000, op: 'close', mint: 'A', sol: 0.02, tokens: 60 }),
    ])
    expect(positions).toHaveLength(1)
    expect(positions[0].proceedsSol).toBeCloseTo(0.05, 8)
    expect(positions[0].buys).toBe(1)
    expect(positions[0].sells).toBe(2)
    expect(positions[0].closed).toBe(true)
  })

  it('treats a re-entry as a second position, not a bigger first one', () => {
    const positions = summarizeLedgerPositions([
      record({ ts: 1_000, op: 'buy', mint: 'A', sol: 0.05, tokens: 100 }),
      record({ ts: 2_000, op: 'close', mint: 'A', sol: 0.04, tokens: 100 }),
      record({ ts: 3_000, op: 'buy', mint: 'A', sol: 0.05, tokens: 100 }),
      record({ ts: 4_000, op: 'close', mint: 'A', sol: 0.09, tokens: 100 }),
    ])
    expect(positions).toHaveLength(2)
    expect(positions.every((p) => p.buys === 1 && p.sells === 1)).toBe(true)
  })

  it('keeps a still-open position and flags it', () => {
    const positions = summarizeLedgerPositions([record({ ts: 1_000, op: 'buy', mint: 'A', sol: 0.05, tokens: 100 })])
    expect(positions[0].closed).toBe(false)
    expect(positions[0].closedAt).toBeNull()
    expect(positions[0].costSol).toBeCloseTo(0.05, 8)
  })

  it('ignores a sell with no open cycle rather than showing proceeds without cost', () => {
    const positions = summarizeLedgerPositions([
      record({ ts: 1_000, op: 'sell', mint: 'A', sol: 0.09, tokens: 100 }),
    ])
    expect(positions).toHaveLength(0)
  })

  it('scopes positions per strategy, so two strategies on one mint stay separate', () => {
    const positions = summarizeLedgerPositions([
      record({ ts: 1_000, op: 'buy', mint: 'A', sol: 0.05, tokens: 100, strategy: 's1' }),
      record({ ts: 1_100, op: 'buy', mint: 'A', sol: 0.05, tokens: 100, strategy: 's2' }),
      record({ ts: 2_000, op: 'close', mint: 'A', sol: 0.10, tokens: 100, strategy: 's1' }),
    ])
    expect(positions).toHaveLength(2)
    const s1 = positions.find((p) => p.strategyId === 's1')!
    const s2 = positions.find((p) => p.strategyId === 's2')!
    expect(s1.closed).toBe(true)
    expect(s2.closed).toBe(false)
  })

  it('skips failed operations', () => {
    const positions = summarizeLedgerPositions([
      record({ ts: 1_000, op: 'buy', mint: 'A', sol: 0.05, successCount: 0, amountSol: 0 }),
    ])
    expect(positions).toHaveLength(0)
  })

  it('keeps the chain so amounts are never summed across chains', () => {
    const positions = summarizeLedgerPositions([
      record({ ts: 1_000, op: 'buy', mint: '0xabc', sol: 0.02, chain: 'robinhood' }),
    ])
    expect(positions[0].chain).toBe('robinhood')
  })
})

describe('summarizeLedger', () => {
  it('separates realized PnL from still-open exposure', () => {
    const positions = summarizeLedgerPositions([
      record({ ts: 1_000, op: 'buy', mint: 'A', sol: 0.05, tokens: 100 }),
      record({ ts: 2_000, op: 'close', mint: 'A', sol: 0.08, tokens: 100 }), // +0.03
      record({ ts: 3_000, op: 'buy', mint: 'B', sol: 0.05, tokens: 100 }), // still open
      record({ ts: 4_000, op: 'buy', mint: 'C', sol: 0.05, tokens: 100 }),
      record({ ts: 5_000, op: 'close', mint: 'C', sol: 0.01, tokens: 100 }), // -0.04
    ])
    const s = summarizeLedger(positions)
    expect(s.positions).toBe(3)
    expect(s.closed).toBe(2)
    expect(s.open).toBe(1)
    expect(s.realizedPnlSol).toBeCloseTo(-0.01, 8)
    expect(s.won).toBe(1)
    expect(s.lost).toBe(1)
    expect(s.winRatePct).toBeCloseTo(50, 6)
    expect(s.grossWinSol).toBeCloseTo(0.03, 8)
    expect(s.grossLossSol).toBeCloseTo(-0.04, 8)
    expect(s.profitFactor).toBeCloseTo(0.75, 6)
    expect(s.realizedPnlPct).toBeCloseTo((-0.01 / 0.1) * 100, 6)
  })

  it('reports a null profit factor when nothing lost, and survives an empty ledger', () => {
    const win = summarizeLedger(
      summarizeLedgerPositions([
        record({ ts: 1_000, op: 'buy', mint: 'A', sol: 0.05, tokens: 100 }),
        record({ ts: 2_000, op: 'close', mint: 'A', sol: 0.09, tokens: 100 }),
      ]),
    )
    expect(win.profitFactor).toBeNull()
    expect(win.winRatePct).toBeCloseTo(100, 6)

    const empty = summarizeLedger([])
    expect(empty.positions).toBe(0)
    expect(empty.realizedPnlSol).toBe(0)
    expect(empty.winRatePct).toBe(0)
    expect(empty.profitFactor).toBeNull()
  })
})
