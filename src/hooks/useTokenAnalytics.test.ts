import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTokenAnalytics } from './useTokenAnalytics'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('fetchTokenAnalytics', () => {
  it('returns {} and does not throw on empty success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ success: true, data: [], missing: [] }),
      })),
    )
    const result = await fetchTokenAnalytics(['MintA'], { maxAgeMinutes: 0 })
    expect(result.data).toEqual({})
    expect(result.missing).toEqual([])
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      '/api/analytics/token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ tokenAddresses: ['MintA'], maxAge: 0 }),
      }),
    )
  })

  it('throws on HTTP error, not on missing mint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ success: false, error: 'boom' }),
      })),
    )
    await expect(fetchTokenAnalytics(['MintA'])).rejects.toThrow(
      'API request failed: 500',
    )
  })
})
