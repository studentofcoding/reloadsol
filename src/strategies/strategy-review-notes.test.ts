import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/utils/db', () => ({
  query: vi.fn(),
}))

import { query } from '@/utils/db'
import {
  upsertStrategyReviewNote,
  listStrategyReviewNotes,
} from './strategy-review-notes'

describe('strategy-review-notes', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset()
  })

  it('deletes row when note is empty', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as never)
    const result = await upsertStrategyReviewNote('2026-W28', '   ')
    expect(result.deleted).toBe(true)
    expect(vi.mocked(query).mock.calls.some((c) => String(c[0]).includes('DELETE'))).toBe(
      true,
    )
  })

  it('upserts non-empty note', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as never)
    const result = await upsertStrategyReviewNote('2026-W28', 'cut size on hot')
    expect(result.deleted).toBe(false)
    expect(result.note).toBe('cut size on hot')
    expect(
      vi.mocked(query).mock.calls.some((c) => String(c[0]).includes('ON CONFLICT')),
    ).toBe(true)
  })

  it('lists notes keyed by period', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [{ period_key: '2026-W28', note: 'hello' }],
      rowCount: 1,
    } as never)
    const notes = await listStrategyReviewNotes({ periodKeys: ['2026-W28'] })
    expect(notes).toEqual({ '2026-W28': 'hello' })
  })
})
