import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({ query: vi.fn() }))

import { query } from '@/utils/db'
import { getLastClosedOutcomeAtByStrategy, resetLastOutcomeCacheForTests } from './strategy-lifecycle-db'

const mockQuery = vi.mocked(query)

describe('getLastClosedOutcomeAtByStrategy', () => {
  beforeEach(() => {
    resetLastOutcomeCacheForTests()
    mockQuery.mockReset()
  })

  it('is a read-only aggregate keyed by strategy id, closed outcomes only', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { strategy_id: 'a', last_exit_at: new Date('2026-10-02T01:02:03.000Z') },
        { strategy_id: 'b', last_exit_at: '2026-09-01T00:00:00.000Z' },
        { strategy_id: 'c', last_exit_at: null },
      ],
      rowCount: 3,
    } as never)
    const out = await getLastClosedOutcomeAtByStrategy(0)
    expect(out).toEqual({ a: '2026-10-02T01:02:03.000Z', b: '2026-09-01T00:00:00.000Z' })
    const sql = String(mockQuery.mock.calls[0]![0])
    expect(sql).toMatch(/^\s*SELECT/i)
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i)
    expect(sql).toContain('exit_at IS NOT NULL')
    expect(sql).toContain('GROUP BY strategy_id')
  })

  it('memoises for 60s', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)
    await getLastClosedOutcomeAtByStrategy(1_000)
    await getLastClosedOutcomeAtByStrategy(30_000)
    expect(mockQuery).toHaveBeenCalledTimes(1)
    await getLastClosedOutcomeAtByStrategy(61_001)
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })
})
