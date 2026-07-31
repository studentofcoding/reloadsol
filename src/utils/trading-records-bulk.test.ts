import { beforeEach, describe, expect, it, vi } from 'vitest'

// REL-20: verify insertTradingRecords applies the exact same per-row rules as
// insertTradingRecord (required-field validation, error/failure skip filter,
// chain parsing, timestamp normalization, post-insert hooks) while issuing a
// single bulkInsert instead of one INSERT per record.

const { bulkInsertMock, queryMock, afterInsertMock } = vi.hoisted(() => ({
  bulkInsertMock: vi.fn(async (opts: any) => ({
    rows: opts.rows.length,
    chunks: 1,
    ms: 1,
  })),
  queryMock: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 1 })),
  afterInsertMock: vi.fn(async () => {}),
}))

vi.mock('@/utils/db', () => ({
  bulkInsert: bulkInsertMock,
  query: queryMock,
}))

vi.mock('@/utils/trading-records-cache', () => ({
  invalidateTradingRecordsCache: () => 0,
}))

vi.mock('@/utils/trading-notifications', () => ({
  broadcastTradeUpdateServer: vi.fn(async () => {}),
}))

import type { TrackingRecord } from './trading-tracker'
import { insertTradingRecord, insertTradingRecords } from './trading-records-db'

function makeRecord(overrides: Partial<TrackingRecord> = {}): TrackingRecord {
  return {
    id: 'rec-1',
    walletAddress: 'wallet-1',
    operationType: 'buy',
    timestamp: 1700000000000,
    chain: 'sol',
    tokens: [],
    successCount: 1,
    failureCount: 0,
    totalTokens: 1,
    solAmount: 0.1,
    feesPaid: 0,
    signatures: [],
    ...overrides,
  } as TrackingRecord
}

beforeEach(() => {
  bulkInsertMock.mockClear()
  queryMock.mockClear()
  afterInsertMock.mockClear()
})

describe('insertTradingRecords (REL-20 bulk path)', () => {
  it('maps records to the same column tuple as the per-row INSERT', async () => {
    const record = makeRecord()
    await insertTradingRecords([record])

    expect(bulkInsertMock).toHaveBeenCalledTimes(1)
    const opts = bulkInsertMock.mock.calls[0][0]
    expect(opts.table).toBe('trading_records')
    expect(opts.columns.map((c: { name: string }) => c.name)).toEqual([
      'id',
      'wallet_address',
      'operation_type',
      'timestamp',
      'data',
      'chain',
    ])
    expect(opts.rows).toEqual([
      [
        'rec-1',
        'wallet-1',
        'buy',
        new Date(1700000000000).toISOString(),
        JSON.stringify({ ...record, chain: 'sol' }),
        'sol',
      ],
    ])
    // No per-row INSERT statements anymore
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('applies the same skip filter as the per-row path', async () => {
    const good = makeRecord({ id: 'ok' })
    const withErrors = makeRecord({ id: 'bad-1', errors: ['x'] })
    const allFailed = makeRecord({ id: 'bad-2', successCount: 0, failureCount: 2 })

    const result = await insertTradingRecords([good, withErrors, allFailed])

    expect(result.inserted).toBe(1)
    expect(result.skipped).toBe(2)
    const opts = bulkInsertMock.mock.calls[0][0]
    expect(opts.rows).toHaveLength(1)
    expect(opts.rows[0][0]).toBe('ok')
  })

  it('normalizes chain via parseDbChain like the per-row path', async () => {
    await insertTradingRecords([makeRecord({ chain: 'robinhood' })])
    const opts = bulkInsertMock.mock.calls[0][0]
    expect(opts.rows[0][5]).toBe('robinhood')
    expect(JSON.parse(opts.rows[0][4] as string).chain).toBe('robinhood')
  })

  it('throws on missing required fields, same as insertTradingRecord', async () => {
    await expect(
      insertTradingRecords([makeRecord({ id: '' })]),
    ).rejects.toThrow('Missing required fields')
    await expect(insertTradingRecord(makeRecord({ id: '' }))).rejects.toThrow(
      'Missing required fields',
    )
  })

  it('propagates bulk DB errors to the caller (no fire-and-forget)', async () => {
    bulkInsertMock.mockRejectedValueOnce(new Error('db down'))
    await expect(insertTradingRecords([makeRecord()])).rejects.toThrow('db down')
  })

  it('still runs the single-row path unchanged when used directly', async () => {
    await insertTradingRecord(makeRecord())
    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO trading_records')
    expect(params[0]).toBe('rec-1')
  })
})
