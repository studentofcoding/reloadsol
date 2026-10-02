import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/utils/db', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

import { query, queryOne } from '@/utils/db'
import {
  ensureCronWorkerRuntimeTable,
  listCronWorkerRuntime,
  upsertCronWorkerRuntimeEvent,
} from './runtime-db'

describe('cron worker runtime db', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('ensures table once then lists rows', async () => {
    vi.mocked(query)
      // CREATE TABLE IF NOT EXISTS
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      // ALTER TABLE ... ADD COLUMN IF NOT EXISTS last_skipped_at — needed separately because the
      // CREATE is a no-op on a table that already exists, so an existing volume would otherwise
      // keep the pre-skip shape forever.
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [
          {
            worker_id: 'social_rollup',
            last_started_at: '2026-07-10T10:00:00.000Z',
            last_success_at: '2026-07-10T10:01:00.000Z',
            last_error_at: null,
            last_error_msg: '',
            last_skipped_at: '2026-07-10T10:02:00.000Z',
            updated_at: '2026-07-10T10:01:00.000Z',
          },
        ],
        rowCount: 1,
      })

    await ensureCronWorkerRuntimeTable()
    await ensureCronWorkerRuntimeTable()
    const rows = await listCronWorkerRuntime()

    const calls = vi.mocked(query).mock.calls.map((c) => String(c[0]))
    expect(calls.filter((c) => c.includes('CREATE TABLE')).length).toBe(1)
    expect(calls.filter((c) => c.includes('ADD COLUMN IF NOT EXISTS last_skipped_at')).length).toBe(1)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.worker_id).toBe('social_rollup')
    expect(rows[0]?.last_success_at).toBe('2026-07-10T10:01:00.000Z')
    expect(rows[0]?.last_skipped_at).toBe('2026-07-10T10:02:00.000Z')
  })

  it('records a skip WITHOUT touching the success or error timestamps', async () => {
    // A held job lock is the lock working, not a failure. The Go side sends `skipped`, and before
    // this branch existed it fell into the failure path and was written as an error.
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 })
    vi.mocked(queryOne).mockResolvedValue({
      worker_id: 'sltp_monitor',
      last_started_at: null,
      last_success_at: null,
      last_error_at: null,
      last_error_msg: null,
      last_skipped_at: '2026-07-10T12:00:00.000Z',
      updated_at: '2026-07-10T12:00:00.000Z',
    })

    await upsertCronWorkerRuntimeEvent({ workerId: 'sltp_monitor', event: 'skipped' })

    const sql = vi.mocked(query).mock.calls.map((c) => String(c[0]))
    const skipWrite = sql.find((s) => s.includes('last_skipped_at'))
    expect(skipWrite).toBeDefined()
    expect(skipWrite).not.toContain('last_error_at')
    expect(skipWrite).not.toContain('last_success_at')
    expect(sql.some((s) => s.includes('last_error_at'))).toBe(false)
  })

  it('upserts success events', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 })
    vi.mocked(queryOne).mockResolvedValue({
      worker_id: 'sltp_monitor',
      last_started_at: null,
      last_success_at: '2026-07-10T12:00:00.000Z',
      last_error_at: null,
      last_error_msg: '',
      updated_at: '2026-07-10T12:00:00.000Z',
    })

    const row = await upsertCronWorkerRuntimeEvent({
      workerId: 'sltp_monitor',
      event: 'success',
      at: '2026-07-10T12:00:00.000Z',
    })

    expect(row?.last_success_at).toBe('2026-07-10T12:00:00.000Z')
    expect(query).toHaveBeenCalled()
  })
})
