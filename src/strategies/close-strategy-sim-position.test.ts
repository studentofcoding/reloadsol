import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  records: vi.fn(async () => [] as unknown[]),
  open: vi.fn(() => [] as unknown[]),
  cycle: vi.fn(() => null as unknown),
  snapshot: vi.fn(async () => null as unknown),
  prices: vi.fn(async () => ({}) as Record<string, number>),
  insert: vi.fn(async (_r: unknown) => undefined),
  outcome: vi.fn(async (_o: unknown) => undefined),
  hasOutcome: vi.fn(async () => false),
  logError: vi.fn(),
}))

vi.mock('@/strategies/db', () => ({
  fetchTradingRecordsForWallet: m.records,
  hasStrategyOutcome: m.hasOutcome,
}))
vi.mock('@/utils/unified-logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: m.logError },
}))
vi.mock('@/strategies/outcomes', () => ({
  recordGmgnOutcome: vi.fn(),
  recordMcapTrackerOutcome: m.outcome,
  recordSignalsOutcome: vi.fn(),
  recordSocialOutcome: vi.fn(),
}))
vi.mock('@/strategies/entry-feature-snapshot', () => ({
  mergeEntryFeaturesForOutcome: (_e: unknown, c: Record<string, unknown>) => c,
}))
vi.mock('@/strategies/resolve-entry-snapshot', () => ({
  ensureCompleteBuyFeaturesForOutcome: vi.fn(),
}))
vi.mock('@/utils/simulation-trades', () => ({
  computeOpenSimCycle: vi.fn(),
  computeOpenTradeCycle: m.cycle,
  scopeRecordsToStrategy: (r: unknown) => r,
}))
vi.mock('@/utils/trading-records-db', () => ({
  buildTradingRecord: (r: unknown) => r,
  insertTradingRecord: m.insert,
}))
vi.mock('@/utils/open-position-prices', () => ({ getOpenPositionPrices: m.prices }))
vi.mock('@/utils/native-usd', () => ({ getNativeUsd: async () => 100 }))
vi.mock('@/utils/mcap-tracker', () => ({
  buildMcapOutcomeFeatures: ({ exitMcap }: { exitMcap: number }) => ({ exit_mcap: exitMcap }),
  computeMcapSimPnlPct: (entry: number, exit: number) => ((exit - entry) / entry) * 100,
  fetchMcapTrackingRow: m.snapshot,
}))
vi.mock('@/utils/mcap-sim-track', () => ({ getOpenMcapSimPositions: m.open }))

import {
  closeMcapStrategySimPositions,
  resolveMcapExit,
} from './close-strategy-sim-position'

const POS = {
  mintAddress: 'MINT',
  symbol: 'TKN',
  entryMcap: 100_000,
  entryAt: '2026-10-03T00:00:00Z',
  entryTemplate: null,
  entryFeatures: {},
}
const CYCLE = { weightedBuyPriceUsd: 0.001, remainingTokenAmount: 1000, totalSolBought: 0.1 }

beforeEach(() => {
  vi.clearAllMocks()
  m.records.mockResolvedValue([{}])
  m.open.mockReturnValue([POS])
  m.cycle.mockReturnValue(CYCLE)
  m.snapshot.mockResolvedValue(null)
  m.prices.mockResolvedValue({})
  m.hasOutcome.mockResolvedValue(false)
})

describe('resolveMcapExit', () => {
  const base = { entryMcap: 100_000, entryPriceUsd: 0.001 }

  it('books the trigger price, mapped to mcap through the entry', () => {
    const r = resolveMcapExit({ ...base, triggerPriceUsd: 0.0015, snapshotMcap: 90_000 })
    expect(r).toEqual({ exitMcap: 150_000, sellPriceUsd: 0.0015, source: 'trigger_price' })
  })

  it('beats a stale snapshot with the trigger price', () => {
    const r = resolveMcapExit({ ...base, triggerPriceUsd: 0.0005, snapshotMcap: 200_000 })
    expect(r.exitMcap).toBe(50_000)
    expect(r.source).toBe('trigger_price')
  })

  it('uses a live read when there is no trigger price', () => {
    const r = resolveMcapExit({ ...base, livePriceUsd: 0.002 })
    expect(r).toMatchObject({ exitMcap: 200_000, source: 'live_price' })
  })

  it('falls to the snapshot with the price implied by its growth', () => {
    const r = resolveMcapExit({ ...base, snapshotMcap: 120_000 })
    expect(r.source).toBe('snapshot')
    expect(r.exitMcap).toBe(120_000)
    expect(r.sellPriceUsd).toBeCloseTo(0.0012, 10)
  })

  it('flags entry_fallback instead of inventing a placeholder price', () => {
    const r = resolveMcapExit(base)
    expect(r).toEqual({ exitMcap: 100_000, sellPriceUsd: 0.001, source: 'entry_fallback' })
    expect(r.sellPriceUsd).not.toBe(0.000001)
  })

  it('ignores non-positive / NaN inputs', () => {
    const r = resolveMcapExit({ ...base, triggerPriceUsd: 0, livePriceUsd: NaN, snapshotMcap: -1 })
    expect(r.source).toBe('entry_fallback')
  })
})

describe('closeMcapStrategySimPositions', () => {
  it('books PnL from the trigger price when the snapshot is missing (was breakeven)', async () => {
    const res = await closeMcapStrategySimPositions('s1', 'sol', {
      mintAddress: 'MINT',
      closeReason: 'sl',
      sellPriceUsd: 0.0007,
    })
    expect(res).toMatchObject({ closed: 1, alreadyClosed: 0, failed: [] })
    const sell = m.insert.mock.calls[0][0] as { tokens: Array<{ priceUsd: number }> }
    expect(sell.tokens[0].priceUsd).toBe(0.0007)
    const out = m.outcome.mock.calls[0][0] as { pnlPct: number; features: Record<string, unknown> }
    expect(out.pnlPct).toBeCloseTo(-30, 6)
    expect(out.features.exit_price_source).toBe('trigger_price')
    expect(m.prices).not.toHaveBeenCalled()
  })

  it('re-reads the live price on the deactivation path and never writes 0.000001', async () => {
    m.prices.mockResolvedValue({ MINT: 0.0013 })
    await closeMcapStrategySimPositions('s1', 'sol')
    const sell = m.insert.mock.calls[0][0] as { tokens: Array<{ priceUsd: number }> }
    expect(sell.tokens[0].priceUsd).toBe(0.0013)
    const out = m.outcome.mock.calls[0][0] as { pnlPct: number; features: Record<string, unknown> }
    expect(out.pnlPct).toBeCloseTo(30, 6)
    expect(out.features.exit_price_source).toBe('live_price')
  })

  it('flags the fallback when nothing is readable', async () => {
    await closeMcapStrategySimPositions('s1', 'sol')
    const sell = m.insert.mock.calls[0][0] as { tokens: Array<{ priceUsd: number }> }
    expect(sell.tokens[0].priceUsd).toBe(0.001)
    const out = m.outcome.mock.calls[0][0] as { features: Record<string, unknown> }
    expect(out.features.exit_price_source).toBe('entry_fallback')
  })

  const SELL = {
    operationType: 'sell',
    is_simulation: true,
    successCount: 1,
    timestamp: 2,
    tokens: [{ mintAddress: 'MINT' }],
  }
  const BUY = {
    operationType: 'buy',
    is_simulation: true,
    successCount: 1,
    timestamp: 1,
    tokens: [{ mintAddress: 'MINT' }],
  }

  it('reports already-closed ONLY with an own sell AND an outcome row, writing nothing', async () => {
    m.open.mockReturnValue([])
    m.records.mockResolvedValue([BUY, SELL])
    m.hasOutcome.mockResolvedValue(true)
    const res = await closeMcapStrategySimPositions('s1', 'sol', {
      mintAddress: 'MINT',
      sellPriceUsd: 0.002,
    })
    expect(res).toEqual({ closed: 1, alreadyClosed: 1, failed: [] })
    expect(m.insert).not.toHaveBeenCalled()
    expect(m.outcome).not.toHaveBeenCalled()
  })

  it('does NOT silently retire when the strategy has no own sell (sibling swallowed it / never booked)', async () => {
    m.open.mockReturnValue([])
    m.records.mockResolvedValue([BUY])
    m.hasOutcome.mockResolvedValue(true)
    const res = await closeMcapStrategySimPositions('s1', 'sol', { mintAddress: 'MINT' })
    expect(res.closed).toBe(0)
    expect(res.alreadyClosed).toBe(0)
    expect(res.failed).toEqual([{ token: 'MINT', error: 'no_own_sell_and_no_open_cycle' }])
    expect(m.logError).toHaveBeenCalled()
    expect(m.insert).not.toHaveBeenCalled()
  })

  it('does NOT retire a mint the strategy never bought', async () => {
    m.open.mockReturnValue([])
    m.records.mockResolvedValue([])
    const res = await closeMcapStrategySimPositions('s1', 'sol', { mintAddress: 'MINT' })
    expect(res).toMatchObject({ closed: 0, alreadyClosed: 0 })
    expect(res.failed[0]).toEqual({ token: 'MINT', error: 'no_buy_in_strategy_ledger' })
  })

  it('does not count a position listed open with an empty scoped cycle as closed', async () => {
    m.cycle.mockReturnValue(null)
    const res = await closeMcapStrategySimPositions('s1', 'sol', { mintAddress: 'MINT' })
    expect(res).toMatchObject({ closed: 0, alreadyClosed: 0 })
    expect(res.failed).toEqual([{ token: 'MINT', error: 'open_without_cycle' }])
    expect(m.insert).not.toHaveBeenCalled()
    expect(m.logError).toHaveBeenCalled()
  })

  it('refuses a sell larger than the strategy-owned open quantity and logs an error', async () => {
    // First call = the cycle the sell is built from (inflated, as an unscoped read would be);
    // second call = the independent scoped recomputation.
    m.cycle
      .mockReturnValueOnce({ ...CYCLE, remainingTokenAmount: 5000 })
      .mockReturnValueOnce({ ...CYCLE, remainingTokenAmount: 1000 })
    const res = await closeMcapStrategySimPositions('s1', 'sol', {
      mintAddress: 'MINT',
      sellPriceUsd: 0.002,
    })
    expect(res.closed).toBe(0)
    expect(res.failed).toEqual([{ token: 'MINT', error: 'sell_qty_exceeds_own_open_qty' }])
    expect(m.insert).not.toHaveBeenCalled()
    expect(m.outcome).not.toHaveBeenCalled()
    expect(m.logError).toHaveBeenCalledWith(
      'error_handling',
      expect.stringContaining('Sell refused'),
      expect.any(Error),
      expect.objectContaining({ strategyId: 's1', mintAddress: 'MINT', sellQty: 5000, ownOpenQty: 1000 }),
    )
  })

  it('propagates an unreadable ledger to the caller instead of treating it as empty', async () => {
    m.records.mockRejectedValueOnce(new Error('pool exhausted'))
    await expect(
      closeMcapStrategySimPositions('s1', 'sol', { mintAddress: 'MINT' }),
    ).rejects.toThrow('pool exhausted')
    expect(m.insert).not.toHaveBeenCalled()
  })

  it('a failed outcome write fails the close (sell written, outcome throws)', async () => {
    m.outcome.mockRejectedValueOnce(new Error('outcome db down'))
    const res = await closeMcapStrategySimPositions('s1', 'sol', {
      mintAddress: 'MINT',
      sellPriceUsd: 0.002,
    })
    expect(res.closed).toBe(0)
    expect(res.failed).toEqual([{ token: 'MINT', error: 'outcome db down' }])
    expect(m.logError).toHaveBeenCalled()
  })

  it('does not treat an empty strategy-wide close as a close (deactivation, nothing open)', async () => {
    m.open.mockReturnValue([])
    const res = await closeMcapStrategySimPositions('s1', 'sol')
    expect(res).toEqual({ closed: 0, alreadyClosed: 0, failed: [] })
  })

  it('reports a write failure and does not count it closed', async () => {
    m.insert.mockRejectedValueOnce(new Error('db down'))
    const res = await closeMcapStrategySimPositions('s1', 'sol', {
      mintAddress: 'MINT',
      sellPriceUsd: 0.002,
    })
    expect(res.closed).toBe(0)
    expect(res.failed).toEqual([{ token: 'MINT', error: 'db down' }])
  })
})
