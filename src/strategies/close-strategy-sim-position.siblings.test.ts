/**
 * Regression: one strategy closing a mint must not sell (or hide) its siblings' tokens.
 *
 * Unlike close-strategy-sim-position.test.ts this does NOT mock the cycle maths: it runs the real
 * `computeOpenTradeCycle` / `scopeRecordsToStrategy` / `getOpenMcapSimPositions` over a shared
 * in-memory ledger that the mocked insert appends to, which is exactly the shape of the 2026-10
 * stall (5 near-identical strategies buying the same mint within minutes).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrackingRecord } from '@/utils/trading-tracker'

const h = vi.hoisted(() => ({
  ledger: [] as unknown[],
  outcomes: [] as Array<Record<string, unknown>>,
  hasOutcome: vi.fn(async (_p: unknown) => false),
  logError: vi.fn(),
  snapshot: vi.fn(async () => null as unknown),
}))

vi.mock('@/strategies/db', () => ({
  fetchTradingRecordsForWallet: vi.fn(async () => [...h.ledger]),
  hasStrategyOutcome: h.hasOutcome,
}))
vi.mock('@/strategies/outcomes', () => ({
  recordGmgnOutcome: vi.fn(async (o: Record<string, unknown>) => {
    h.outcomes.push(o)
  }),
  recordMcapTrackerOutcome: vi.fn(async (o: Record<string, unknown>) => {
    h.outcomes.push(o)
  }),
  recordSignalsOutcome: vi.fn(),
  recordSocialOutcome: vi.fn(),
}))
vi.mock('@/strategies/entry-feature-snapshot', () => ({
  mergeEntryFeaturesForOutcome: (_e: unknown, c: Record<string, unknown>) => c,
}))
vi.mock('@/strategies/resolve-entry-snapshot', () => ({
  ensureCompleteBuyFeaturesForOutcome: vi.fn(async () => ({})),
}))
vi.mock('@/utils/trading-records-db', () => ({
  buildTradingRecord: (r: Record<string, unknown>) => ({ ...r, timestamp: Date.now() + h.ledger.length }),
  insertTradingRecord: vi.fn(async (r: unknown) => {
    h.ledger.push(r)
  }),
}))
vi.mock('@/utils/open-position-prices', () => ({ getOpenPositionPrices: vi.fn(async () => ({})) }))
vi.mock('@/utils/native-usd', () => ({ getNativeUsd: async () => 100 }))
vi.mock('@/utils/unified-logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: h.logError },
}))
vi.mock('@/utils/mcap-tracker', () => ({
  buildMcapOutcomeFeatures: ({ exitMcap }: { exitMcap: number }) => ({ exit_mcap: exitMcap }),
  computeMcapSimPnlPct: (entry: number, exit: number) => ((exit - entry) / entry) * 100,
  fetchMcapTrackingRow: h.snapshot,
  isInTrackingRange: () => true,
}))

import {
  closeMcapStrategySimPositions,
  closePriceStrategySimPosition,
  sellQtyWithinOwnOpenQty,
} from './close-strategy-sim-position'
import { getOpenMcapSimPositions } from '@/utils/mcap-sim-track'
import { getOpenStrategySimPositions } from './open-strategy-sim-positions'
import { computeOpenTradeCycle, scopeRecordsToStrategy } from '@/utils/simulation-trades'

const MINT = 'MintSiblingXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
const A = 'mcap_enter_at_80'
const B = 'search_mcap_tp150_h48'
const C = 'search_mcap_tp200_h48'
const QTY: Record<string, number> = { [A]: 4533, [B]: 6149, [C]: 6121 }
const PRICE = 0.001

function buy(strategy: string, ts: number): TrackingRecord {
  return {
    id: `buy-${strategy}`,
    timestamp: ts,
    walletAddress: 'mcap-tracker-sim',
    operationType: 'buy',
    is_simulation: true,
    simulation_type: 'strategy',
    bot_strategy: strategy,
    successCount: 1,
    failureCount: 0,
    totalTokens: 1,
    solAmount: 0.1,
    tokens: [
      {
        mintAddress: MINT,
        symbol: 'SIB',
        tokenAmount: QTY[strategy],
        solAmount: 0.1,
        priceUsd: PRICE,
      },
    ],
    trading_simulation: {
      entry_at: '2026-10-01T10:00:00.000Z',
      entry_features: { entry_mcap: 100_000, entry_template: 'milestone_80' },
    },
  } as unknown as TrackingRecord
}

function seed(strategies: string[]) {
  h.ledger = strategies.map((s, i) => buy(s, 1000 + i))
}

const own = (records: unknown[], strategy: string) =>
  records.filter((r) => (r as TrackingRecord).bot_strategy === strategy) as TrackingRecord[]

beforeEach(() => {
  h.ledger = []
  h.outcomes = []
  h.hasOutcome.mockReset()
  h.hasOutcome.mockResolvedValue(false)
  h.logError.mockClear()
  h.snapshot.mockResolvedValue(null)
})

describe('mcap closer: 3 sibling strategies, same mint', () => {
  it('closing the first sells ONLY its own tokens and leaves the siblings untouched', async () => {
    seed([A, B, C])
    const before = JSON.stringify(h.ledger)

    const res = await closeMcapStrategySimPositions(A, 'sol', {
      mintAddress: MINT,
      closeReason: 'stop_loss',
      sellPriceUsd: 0.0007,
    })
    expect(res).toMatchObject({ closed: 1, alreadyClosed: 0, failed: [] })

    // Exactly one new record: A's sell, for A's quantity, not the 16,803 mint-wide total.
    const added = h.ledger.slice(3) as TrackingRecord[]
    expect(added).toHaveLength(1)
    expect(added[0].operationType).toBe('sell')
    expect(added[0].bot_strategy).toBe(A)
    expect(added[0].tokens[0].tokenAmount).toBe(QTY[A])
    expect(added.some((r) => r.bot_strategy === B || r.bot_strategy === C)).toBe(false)

    // The siblings' buys are byte-identical and nothing was sold for them.
    expect(JSON.stringify(h.ledger.slice(0, 3))).toBe(before)
    for (const sib of [B, C]) {
      expect(own(h.ledger, sib).filter((r) => r.operationType === 'sell')).toHaveLength(0)
      const cycle = computeOpenTradeCycle(scopeRecordsToStrategy(h.ledger as TrackingRecord[], sib), MINT, 'sim')
      expect(cycle?.remainingTokenAmount).toBe(QTY[sib])
      // Still counted open for the cap, with the position intact.
      expect(getOpenMcapSimPositions(h.ledger as TrackingRecord[], sib).map((p) => p.mintAddress)).toEqual([MINT])
    }
    // The closer's own cycle is flat and it wrote its own outcome.
    expect(getOpenMcapSimPositions(h.ledger as TrackingRecord[], A)).toHaveLength(0)
    expect(h.outcomes).toHaveLength(1)
    expect(h.outcomes[0].strategyId).toBe(A)
    expect(h.outcomes[0].pnlPct).toBeCloseTo(-30, 6)
    // The stake handed to the outcome is A's own, not the mint-wide 0.3 SOL.
    expect(h.outcomes[0].solAmount).toBeCloseTo(0.1, 10)
  })

  it('each sibling then closes its own tokens on its own trigger; none is left an orphan', async () => {
    seed([A, B, C])
    await closeMcapStrategySimPositions(A, 'sol', { mintAddress: MINT, sellPriceUsd: 0.0007 })
    h.hasOutcome.mockResolvedValue(false)
    const rb = await closeMcapStrategySimPositions(B, 'sol', { mintAddress: MINT, sellPriceUsd: 0.0015 })
    const rc = await closeMcapStrategySimPositions(C, 'sol', { mintAddress: MINT, sellPriceUsd: 0.0005 })
    expect(rb).toMatchObject({ closed: 1, alreadyClosed: 0, failed: [] })
    expect(rc).toMatchObject({ closed: 1, alreadyClosed: 0, failed: [] })

    const sells = (h.ledger as TrackingRecord[]).filter((r) => r.operationType === 'sell')
    expect(sells.map((s) => [s.bot_strategy, s.tokens[0].tokenAmount])).toEqual([
      [A, QTY[A]],
      [B, QTY[B]],
      [C, QTY[C]],
    ])
    expect(h.outcomes.map((o) => [o.strategyId, Math.round(o.pnlPct as number)])).toEqual([
      [A, -30],
      [B, 50],
      [C, -50],
    ])
    for (const s of [A, B, C]) {
      expect(getOpenMcapSimPositions(h.ledger as TrackingRecord[], s)).toHaveLength(0)
    }
  })

  it('a sibling whose tokens were swallowed by an OLD unscoped sell is no longer silently retired', async () => {
    // Pre-fix ledger: A's sell carries the mint-wide quantity (A+B), booked under A only.
    h.ledger = [
      buy(A, 1000),
      buy(B, 1001),
      {
        ...buy(A, 2000),
        id: 'swallow',
        operationType: 'sell',
        close_position: true,
        tokens: [{ mintAddress: MINT, tokenAmount: QTY[A] + QTY[B], solAmount: 0.2, priceUsd: PRICE }],
      } as unknown as TrackingRecord,
    ]
    // Scoped, B still holds its tokens: B's own close now writes B's sell + outcome.
    const res = await closeMcapStrategySimPositions(B, 'sol', { mintAddress: MINT, sellPriceUsd: 0.0007 })
    expect(res).toMatchObject({ closed: 1, alreadyClosed: 0, failed: [] })
    const sell = (h.ledger as TrackingRecord[]).at(-1)!
    expect(sell.bot_strategy).toBe(B)
    expect(sell.tokens[0].tokenAmount).toBe(QTY[B])
    expect(h.outcomes.map((o) => o.strategyId)).toEqual([B])
  })

  it('recovers a missing outcome from the strategy\'s own existing sell without writing a second sell', async () => {
    h.ledger = [
      buy(A, 1000),
      {
        ...buy(A, 2000),
        id: 'sell-no-outcome',
        operationType: 'sell',
        close_position: true,
        tokens: [{ mintAddress: MINT, tokenAmount: QTY[A], solAmount: 0.07, priceUsd: 0.0007 }],
        trading_simulation: { close_reason: 'stop_loss' },
      } as unknown as TrackingRecord,
    ]
    h.hasOutcome.mockResolvedValue(false)
    const res = await closeMcapStrategySimPositions(A, 'sol', { mintAddress: MINT, sellPriceUsd: 0.0001 })
    expect(res).toMatchObject({ closed: 1, alreadyClosed: 0, failed: [] })
    expect(h.ledger).toHaveLength(2) // no second sell
    expect(h.outcomes).toHaveLength(1)
    expect(h.outcomes[0].pnlPct).toBeCloseTo(-30, 6) // the price the sell booked, not the new trigger
    expect((h.outcomes[0].features as Record<string, unknown>).outcome_recovered_from_sell).toBe(true)
  })

  it('treats own sell + outcome as already closed, and nothing else as closed', async () => {
    h.ledger = [
      buy(A, 1000),
      {
        ...buy(A, 2000),
        operationType: 'sell',
        close_position: true,
        tokens: [{ mintAddress: MINT, tokenAmount: QTY[A], solAmount: 0.07, priceUsd: 0.0007 }],
      } as unknown as TrackingRecord,
    ]
    h.hasOutcome.mockResolvedValue(true)
    const done = await closeMcapStrategySimPositions(A, 'sol', { mintAddress: MINT })
    expect(done).toEqual({ closed: 1, alreadyClosed: 1, failed: [] })
    expect(h.ledger).toHaveLength(2)
    expect(h.outcomes).toHaveLength(0)
  })
})

describe('sellQtyWithinOwnOpenQty', () => {
  it('allows equal / float-noise quantities and refuses anything larger, logging at error level', () => {
    expect(sellQtyWithinOwnOpenQty({ strategyId: 's', mintAddress: 'm', sellQty: 100, ownOpenQty: 100 })).toBe(true)
    expect(
      sellQtyWithinOwnOpenQty({ strategyId: 's', mintAddress: 'm', sellQty: 100 + 1e-8, ownOpenQty: 100 }),
    ).toBe(true)
    expect(h.logError).not.toHaveBeenCalled()
    expect(sellQtyWithinOwnOpenQty({ strategyId: 's', mintAddress: 'm', sellQty: 101, ownOpenQty: 100 })).toBe(false)
    expect(sellQtyWithinOwnOpenQty({ strategyId: 's', mintAddress: 'm', sellQty: NaN, ownOpenQty: 100 })).toBe(false)
    expect(h.logError).toHaveBeenCalledTimes(2)
  })
})

describe('price-domain closer is scoped too', () => {
  it('closing one gmgn strategy sells only its own quantity', async () => {
    const G1 = 'gmgn_a'
    const G2 = 'gmgn_b'
    h.ledger = [buy(G1, 1000), buy(G2, 1001)]
    QTY[G1] = 1000
    QTY[G2] = 2500
    ;(h.ledger[0] as TrackingRecord).tokens[0].tokenAmount = 1000
    ;(h.ledger[1] as TrackingRecord).tokens[0].tokenAmount = 2500

    await closePriceStrategySimPosition({
      domain: 'gmgn',
      chain: 'sol',
      strategyId: G1,
      mintAddress: MINT,
      symbol: 'SIB',
      entryAt: null,
      entryFeatures: {},
      closeReason: 'stop_loss',
      sellPriceUsd: 0.0007,
    })
    const sells = (h.ledger as TrackingRecord[]).filter((r) => r.operationType === 'sell')
    expect(sells).toHaveLength(1)
    expect(sells[0].bot_strategy).toBe(G1)
    expect(sells[0].tokens[0].tokenAmount).toBe(1000)
    expect(
      computeOpenTradeCycle(scopeRecordsToStrategy(h.ledger as TrackingRecord[], G2), MINT, 'sim')
        ?.remainingTokenAmount,
    ).toBe(2500)
    expect(getOpenStrategySimPositions(h.ledger as TrackingRecord[], G2).map((p) => p.mintAddress)).toEqual([MINT])
    expect(getOpenStrategySimPositions(h.ledger as TrackingRecord[], G1)).toHaveLength(0)
  })
})
