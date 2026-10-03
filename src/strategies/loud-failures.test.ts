/**
 * Failures that used to be swallowed are loud now:
 *  - insertStrategyOutcome throws on a DB error (it logged a warning and returned false, and the
 *    mcap closer ignored the return, so a sell was written with no outcome);
 *  - fetchTradingRecordsForWallet throws on a DB error (it returned [], which callers read as
 *    "no records" -> "already closed" / "nothing open").
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))
vi.mock('@/utils/dlmm/db', () => ({ getAgentConfig: vi.fn(async () => ({ id: 'cfg', dry_run: true })) }))
const notify = vi.hoisted(() => vi.fn())
vi.mock('@/strategies/strategy-telegram-notify', () => ({ notifyStrategyClose: notify }))
vi.mock('@/strategies/strategy-episodes', () => ({ scheduleEpisodeFinalize: vi.fn() }))
vi.mock('@/strategies/eval-engine-db', () => ({ resolvePredictionsForClosedOutcome: vi.fn(async () => 0) }))
const logError = vi.hoisted(() => vi.fn())
vi.mock('@/utils/unified-logger', () => ({
  log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: logError },
}))

import { query, queryOne } from '@/utils/db'
import { resetWalletRecordsCacheForTests } from '@/utils/wallet-records-cache'
import { fetchTradingRecordsForWallet, insertStrategyOutcome, listStrategyOutcomes } from './db'
import { recordDlmmOutcome, recordMcapTrackerOutcome } from './outcomes'
import { tryFetchWalletRecords } from './safe-wallet-records'

const mockQuery = vi.mocked(query)
const mockQueryOne = vi.mocked(queryOne)

beforeEach(() => {
  vi.clearAllMocks()
  resetWalletRecordsCacheForTests()
  mockQueryOne.mockResolvedValue(null as never)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

function failInsert(message = 'connection terminated') {
  mockQuery.mockImplementation(async (sql: string) => {
    if (String(sql).includes('INSERT INTO strategy_outcomes')) throw new Error(message)
    return { rows: [], rowCount: 0 } as never
  })
}

describe('insertStrategyOutcome', () => {
  it('rethrows a DB error (and logs it at error level) instead of returning false', async () => {
    failInsert()
    await expect(
      insertStrategyOutcome({ strategy_id: 's1', domain: 'mcap_tracker', token_address: 'MINT' }),
    ).rejects.toThrow('connection terminated')
    expect(console.error).toHaveBeenCalled()
  })

  it('returns true on success', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'o1', op: 'updated' }], rowCount: 1 } as never)
    await expect(
      insertStrategyOutcome({ strategy_id: 's1', domain: 'mcap_tracker', token_address: 'MINT' }),
    ).resolves.toBe(true)
  })
})

describe('outcome recorders', () => {
  it('recordMcapTrackerOutcome propagates the failure and sends no close notification', async () => {
    failInsert()
    await expect(
      recordMcapTrackerOutcome({ strategyId: 's1', tokenAddress: 'MINT', pnlPct: -10 }),
    ).rejects.toThrow('connection terminated')
    expect(notify).not.toHaveBeenCalled()
  })

  it('recordDlmmOutcome keeps its legacy contract: error logged, false returned, nothing thrown', async () => {
    failInsert()
    await expect(
      recordDlmmOutcome({ poolAddress: 'Pool1', mintAddress: 'MINT', pnlPct: 1 }),
    ).resolves.toBe(false)
    expect(console.error).toHaveBeenCalled()
  })
})

describe('fetchTradingRecordsForWallet', () => {
  it('throws on a DB error instead of returning an empty ledger', async () => {
    mockQuery.mockRejectedValueOnce(new Error('pool exhausted'))
    await expect(fetchTradingRecordsForWallet('mcap-tracker-sim')).rejects.toThrow('pool exhausted')
    expect(console.error).toHaveBeenCalled()
  })

  it('does not cache the failure: the next read goes back to the DB', async () => {
    mockQuery.mockRejectedValueOnce(new Error('pool exhausted'))
    await expect(fetchTradingRecordsForWallet('mcap-tracker-sim')).rejects.toThrow()
    mockQuery.mockResolvedValueOnce({ rows: [{ data: { id: 'r1' } }], rowCount: 1 } as never)
    await expect(fetchTradingRecordsForWallet('mcap-tracker-sim')).resolves.toEqual([{ id: 'r1' }])
  })

  it('sinceLastClose reads throw too', async () => {
    mockQuery.mockRejectedValueOnce(new Error('timeout'))
    await expect(fetchTradingRecordsForWallet('w', { sinceLastClose: true })).rejects.toThrow('timeout')
  })
})

describe('tryFetchWalletRecords (cron-loop guard)', () => {
  it('returns null and logs at error level with context; never an empty array', async () => {
    mockQuery.mockRejectedValueOnce(new Error('pool exhausted'))
    const r = await tryFetchWalletRecords('mcap-tracker-sim', { strategyId: 's1', phase: 'open_gate' })
    expect(r).toBeNull()
    expect(logError).toHaveBeenCalledWith(
      'error_handling',
      expect.stringContaining('NOT treating it as an empty ledger'),
      expect.any(Error),
      expect.objectContaining({ strategyId: 's1', phase: 'open_gate', walletAddress: 'mcap-tracker-sim' }),
    )
  })

  it('passes records through on success', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await expect(tryFetchWalletRecords('w', {})).resolves.toEqual([])
  })
})

describe('performance reads exclude bookkeeping closes (orphan_reconcile)', () => {
  it('listStrategyOutcomes filters them by default and can opt in', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)
    await listStrategyOutcomes({ strategyId: 's1' })
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]))
    expect(sqls.some((q) => q.includes(`COALESCE(features->>'close_reason', '') NOT IN ('orphan_reconcile')`))).toBe(true)

    mockQuery.mockClear()
    await listStrategyOutcomes({ strategyId: 's1', includeNonTrade: true })
    const after = mockQuery.mock.calls.map((c) => String(c[0]))
    expect(after.length).toBeGreaterThan(0)
    expect(after.some((q) => q.includes('orphan_reconcile'))).toBe(false)
  })
})
