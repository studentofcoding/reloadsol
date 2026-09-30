import { describe, expect, it } from 'vitest'
import { modelledDragSol, summarizeLedger, summarizeLedgerPositions } from './ledger-pnl'
import { resolveExecutionParams } from './execution-model'
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

describe('modelledDragSol', () => {
  it('is a real cost for a real position, and grows with size', () => {
    const small = modelledDragSol(0.005)
    const large = modelledDragSol(0.05)
    expect(small).toBeGreaterThan(0)
    expect(large).toBeGreaterThan(small)
  })

  it('is zero for a non-positive stake rather than NaN', () => {
    for (const cost of [0, -1, Number.NaN]) {
      expect(modelledDragSol(cost)).toBe(0)
    }
  })

  it('is bounded by the stake plus the FIXED costs, which do not scale down', () => {
    // The first version of this test asserted the drag is always smaller than the stake, and it
    // failed — correctly. The fixed priority/tip cost is per side, so at the default
    // SIM_PRIORITY_FEE_QUOTE=0.002 a 0.001 SOL position pays several times its own size in fixed
    // costs. That is the model telling the truth about small positions rather than a bug, so the
    // bound is stake + both sides' fixed cost.
    const fixed = resolveExecutionParams().priorityFeeQuote * 2
    for (const cost of [0.001, 0.005, 0.05, 0.5]) {
      expect(modelledDragSol(cost)).toBeLessThan(cost + fixed + 1e-9)
    }
  })

  it('shows the fixed cost dominating the smallest stake', () => {
    // Worth pinning, because it is a real constraint on position sizing: at 0.005 SOL with the
    // default 0.002 per side, the round trip alone consumes most of the position.
    const fixed = resolveExecutionParams().priorityFeeQuote * 2
    expect(modelledDragSol(0.005)).toBeGreaterThan(fixed * 0.9)
  })
})

describe('summarizeLedger net figures', () => {
  it('subtracts the modelled drag from the realized result', () => {
    const positions = summarizeLedgerPositions([
      record({ ts: 1_000, op: 'buy', mint: 'A', sol: 0.05, tokens: 100 }),
      record({ ts: 2_000, op: 'close', mint: 'A', sol: 0.06, tokens: 100 }),
    ])
    const s = summarizeLedger(positions)
    expect(s.realizedPnlSol).toBeCloseTo(0.01, 8)
    expect(s.modelledDragSol).toBeGreaterThan(0)
    expect(s.realizedNetSol).toBeCloseTo(0.01 - s.modelledDragSol, 10)
    expect(s.realizedNetSol).toBeLessThan(s.realizedPnlSol)
  })

  it('applies no drag when nothing closed', () => {
    const s = summarizeLedger(
      summarizeLedgerPositions([record({ ts: 1_000, op: 'buy', mint: 'A', sol: 0.05, tokens: 100 })]),
    )
    expect(s.closed).toBe(0)
    expect(s.modelledDragSol).toBe(0)
    expect(s.realizedNetSol).toBe(0)
  })
})

import { buildStrategyReadiness, peakConcurrentPositions } from './ledger-pnl'

function pos(o: Partial<import('./ledger-pnl').LedgerPosition> & { strategyId: string }) {
  return {
    mintAddress: 'm',
    symbol: 'TOK',
    chain: 'sol',
    costSol: 0.005,
    proceedsSol: 0.0055,
    pnlSol: 0.0005,
    pnlPct: 10,
    buys: 1,
    sells: 1,
    openedAt: 1_000,
    closedAt: 2_000,
    closed: true,
    ...o,
  }
}

describe('peakConcurrentPositions', () => {
  it('counts overlap, and does not count touching intervals', () => {
    expect(peakConcurrentPositions([pos({ strategyId: 'a', openedAt: 1, closedAt: 2 }), pos({ strategyId: 'a', openedAt: 2, closedAt: 3 })])).toBe(1)
    expect(peakConcurrentPositions([pos({ strategyId: 'a', openedAt: 1, closedAt: 5 }), pos({ strategyId: 'a', openedAt: 2, closedAt: 3 })])).toBe(2)
  })

  it('treats an open position as still running', () => {
    expect(peakConcurrentPositions([pos({ strategyId: 'a', openedAt: 1, closedAt: 2 }), pos({ strategyId: 'a', openedAt: 3, closedAt: null, closed: false })])).toBe(1)
  })
})

describe('buildStrategyReadiness', () => {
  it('separates a candidate from a strategy whose drag eats it', () => {
    const out = buildStrategyReadiness([
      // healthy: repeated positive trades
      pos({ strategyId: 'good', pnlSol: 0.0004, costSol: 0.005, pnlPct: 8 }),
      pos({ strategyId: 'good', pnlSol: 0.0004, costSol: 0.005, pnlPct: 8, openedAt: 5_000, closedAt: 6_000 }),
      // break-even: gross is flat, the fixed drag makes it negative
      pos({ strategyId: 'flat', pnlSol: 0, costSol: 0.0015, pnlPct: 0 }),
      pos({ strategyId: 'flat', pnlSol: 0, costSol: 0.0015, pnlPct: 0 }),
    ])
    const good = out.find((s) => s.strategyId === 'good')!
    const flat = out.find((s) => s.strategyId === 'flat')!
    expect(good.netPerTradeSol).toBeGreaterThan(0)
    expect(good.medianPnlPct).toBe(8)
    expect(good.verdict).toBe('candidate')
    expect(flat.netPerTradeSol).toBeLessThan(0)
    expect(flat.verdict).toBe('not_viable')
  })

  it('sorts by net per trade and ignores strategies with nothing closed', () => {
    const out = buildStrategyReadiness([
      pos({ strategyId: 'small', pnlSol: 0.0001, costSol: 0.005, pnlPct: 2 }),
      pos({ strategyId: 'big', pnlSol: 0.0010, costSol: 0.005, pnlPct: 20 }),
      pos({ strategyId: 'open-only', closed: false, closedAt: null, pnlSol: 0 }),
    ])
    expect(out.map((s) => s.strategyId)).toEqual(['big', 'small'])
  })
})
