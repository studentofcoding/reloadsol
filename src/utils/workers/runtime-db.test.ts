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
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [
          {
            worker_id: 'social_rollup',
            last_started_at: '2026-07-10T10:00:00.000Z',
            last_success_at: '2026-07-10T10:01:00.000Z',
            last_error_at: null,
            last_error_msg: '',
            updated_at: '2026-07-10T10:01:00.000Z',
          },
        ],
        rowCount: 1,
      })

    await ensureCronWorkerRuntimeTable()
    await ensureCronWorkerRuntimeTable()
    const rows = await listCronWorkerRuntime()

    expect(vi.mocked(query).mock.calls.filter((c) => String(c[0]).includes('CREATE TABLE')).length).toBe(1)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.worker_id).toBe('social_rollup')
    expect(rows[0]?.last_success_at).toBe('2026-07-10T10:01:00.000Z')
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
