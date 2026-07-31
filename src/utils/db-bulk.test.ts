import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock node-pg so no real DATABASE_URL / pool is needed. The pool query mock
// captures every statement issued by the bulk helpers.
const { poolQuery } = vi.hoisted(() => ({
  poolQuery: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 })),
}))

vi.mock('pg', () => ({
  Pool: class {
    query = poolQuery
  },
  types: { setTypeParser: () => {} },
}))

vi.mock('./db-health', () => ({
  isDbCircuitOpen: () => false,
  isDbConnectivityError: () => false,
  recordDbFailure: () => {},
  recordDbSuccess: () => {},
}))

import { bulkInsert, bulkUpdateByKey, WriteBatch } from './db'

beforeEach(() => {
  poolQuery.mockClear()
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test'
})

describe('bulkInsert (REL-20)', () => {
  it('emits a single UNNEST upsert with per-column array params', async () => {
    const stats = await bulkInsert({
      table: 'trending_token_tracker',
      columns: [
        { name: 'id', type: 'text' },
        { name: 'token_address', type: 'text' },
        { name: 'initial_price_usd', type: 'float8' },
        { name: 'trading_simulation', type: 'jsonb' },
        { name: 'tracking_started_at', type: 'timestamptz' },
      ],
      rows: [
        ['track_a_1', 'mintA', 1.5, '{"a":1}', '2024-01-01T00:00:00.000Z'],
        ['track_b_2', 'mintB', 2.5, null, '2024-01-02T00:00:00.000Z'],
      ],
      conflictTarget: '(token_address)',
      updateColumns: ['id', 'initial_price_usd', 'trading_simulation', 'tracking_started_at'],
      extraSet: ['updated_at = NOW()'],
    })

    expect(poolQuery).toHaveBeenCalledTimes(1)
    const [sql, params] = poolQuery.mock.calls[0]
    expect(sql).toBe(
      'INSERT INTO trending_token_tracker (id, token_address, initial_price_usd, trading_simulation, tracking_started_at) ' +
        'SELECT * FROM UNNEST($1::text[], $2::text[], $3::float8[], $4::jsonb[], $5::timestamptz[]) ' +
        'AS v(id, token_address, initial_price_usd, trading_simulation, tracking_started_at) ' +
        'ON CONFLICT (token_address) DO UPDATE SET ' +
        'id = EXCLUDED.id, initial_price_usd = EXCLUDED.initial_price_usd, ' +
        'trading_simulation = EXCLUDED.trading_simulation, ' +
        'tracking_started_at = EXCLUDED.tracking_started_at, updated_at = NOW()',
    )
    // Column-oriented arrays, row order preserved
    expect(params).toEqual([
      ['track_a_1', 'track_b_2'],
      ['mintA', 'mintB'],
      [1.5, 2.5],
      ['{"a":1}', null],
      ['2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z'],
    ])
    expect(stats).toEqual({ rows: 2, chunks: 1, ms: expect.any(Number) })
  })

  it('emits ON CONFLICT DO NOTHING when no update columns are given', async () => {
    await bulkInsert({
      table: 't',
      columns: [{ name: 'id', type: 'text' }],
      rows: [['a']],
      conflictTarget: '(id)',
    })
    expect(poolQuery.mock.calls[0][0]).toContain('ON CONFLICT (id) DO NOTHING')
  })

  it('omits the conflict clause entirely when no target is given', async () => {
    await bulkInsert({
      table: 't',
      columns: [{ name: 'id', type: 'text' }],
      rows: [['a']],
    })
    expect(poolQuery.mock.calls[0][0]).not.toContain('ON CONFLICT')
  })

  it('chunks large batches to bound parameter counts', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => [`id${i}`])
    const stats = await bulkInsert({
      table: 't',
      columns: [{ name: 'id', type: 'text' }],
      rows,
      chunkRows: 2,
    })
    expect(poolQuery).toHaveBeenCalledTimes(3)
    expect(poolQuery.mock.calls[0][1]).toEqual([['id0', 'id1']])
    expect(poolQuery.mock.calls[2][1]).toEqual([['id4']])
    expect(stats).toEqual({ rows: 5, chunks: 3, ms: expect.any(Number) })
  })

  it('is a no-op for empty batches', async () => {
    const stats = await bulkInsert({
      table: 't',
      columns: [{ name: 'id', type: 'text' }],
      rows: [],
    })
    expect(poolQuery).not.toHaveBeenCalled()
    expect(stats).toEqual({ rows: 0, chunks: 0, ms: 0 })
  })
})

describe('bulkUpdateByKey (REL-20)', () => {
  it('emits UPDATE ... FROM UNNEST with the key as the last param', async () => {
    await bulkUpdateByKey({
      table: 'trending_token_tracker',
      key: { name: 'id', type: 'text' },
      columns: [
        { name: 'last_price_usd', type: 'float8' },
        { name: 'status', type: 'text' },
      ],
      rows: [
        [1.1, 'tracking', 'id-a'],
        [2.2, 'lost', 'id-b'],
      ],
      extraSet: ['updated_at = NOW()'],
    })

    expect(poolQuery).toHaveBeenCalledTimes(1)
    const [sql, params] = poolQuery.mock.calls[0]
    expect(sql).toBe(
      'UPDATE trending_token_tracker AS t SET ' +
        'last_price_usd = v.last_price_usd, status = v.status, updated_at = NOW() ' +
        'FROM (SELECT * FROM UNNEST($1::float8[], $2::text[], $3::text[]) ' +
        'AS v(last_price_usd, status, id)) AS v WHERE t.id = v.id',
    )
    expect(params).toEqual([
      [1.1, 2.2],
      ['tracking', 'lost'],
      ['id-a', 'id-b'],
    ])
  })
})

describe('WriteBatch (REL-20)', () => {
  it('flushes collected rows once and runs after hooks on success', async () => {
    const flushRows = vi.fn(async () => ({ rows: 2, chunks: 1, ms: 3 }))
    const after = vi.fn()
    const onError = vi.fn()
    const batch = new WriteBatch('test', flushRows)

    batch.add(['a', 1], { after })
    batch.add(['b', 2], { after, onError })
    expect(batch.size).toBe(2)

    const result = await batch.flush()
    expect(result.ok).toBe(true)
    expect(result.stats.rows).toBe(2)
    expect(flushRows).toHaveBeenCalledTimes(1)
    expect(flushRows).toHaveBeenCalledWith([
      ['a', 1],
      ['b', 2],
    ])
    expect(after).toHaveBeenCalledTimes(2)
    expect(onError).not.toHaveBeenCalled()
    expect(batch.size).toBe(0)
  })

  it('runs onError hooks and resolves ok=false when the flush fails', async () => {
    const failure = new Error('boom')
    const flushRows = vi.fn(async () => {
      throw failure
    })
    const after = vi.fn()
    const onError = vi.fn()
    const batch = new WriteBatch('test', flushRows)
    batch.add(['a'], { after, onError })

    const result = await batch.flush()
    expect(result.ok).toBe(false)
    expect(result.error).toBe(failure)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(failure)
    expect(after).not.toHaveBeenCalled()
  })

  it('flush is a no-op when nothing was collected', async () => {
    const flushRows = vi.fn(async () => ({ rows: 0, chunks: 0, ms: 0 }))
    const batch = new WriteBatch('test', flushRows)
    const result = await batch.flush()
    expect(result.ok).toBe(true)
    expect(flushRows).not.toHaveBeenCalled()
  })
})
