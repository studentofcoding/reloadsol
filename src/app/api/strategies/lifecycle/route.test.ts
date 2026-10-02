import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server')
  return { ...actual, connection: vi.fn(async () => undefined) }
})
vi.mock('@/strategies/strategy-lifecycle-db', () => ({
  getLastClosedOutcomeAtByStrategy: vi.fn(),
}))

import { getLastClosedOutcomeAtByStrategy } from '@/strategies/strategy-lifecycle-db'
import { GET } from './route'

const mockLookup = vi.mocked(getLastClosedOutcomeAtByStrategy)

describe('GET /api/strategies/lifecycle', () => {
  beforeEach(() => {
    mockLookup.mockReset()
  })

  it('returns the latest closed outcome per strategy', async () => {
    mockLookup.mockResolvedValue({ a: '2026-10-02T00:00:00.000Z' })
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, last_outcome_at: { a: '2026-10-02T00:00:00.000Z' } })
  })

  it('a failed lookup is a 500 with the error, not an empty map (empty would read as "all trial")', async () => {
    mockLookup.mockRejectedValue(new Error('db down'))
    const res = await GET()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'db down' })
  })
})
