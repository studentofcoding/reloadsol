import { afterEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
const getUsdPrices = vi.fn()

vi.mock('@/utils/db', () => ({
  query: (...args: unknown[]) => query(...args),
}))

vi.mock('@/utils/usd-prices', () => ({
  getUsdPrices: (...args: unknown[]) => getUsdPrices(...args),
}))

import { NextRequest } from 'next/server'
import { POST } from '@/app/api/analytics/token/route'

afterEach(() => {
  query.mockReset()
  getUsdPrices.mockReset()
})

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/analytics/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function mcapRow(address: string, overrides: Record<string, unknown> = {}) {
  return {
    token_address: address,
    token_symbol: address.slice(0, 4).toUpperCase(),
    first_mcap: 50_000,
    current_mcap: 80_000,
    mcap_growth_percent: 60,
    first_seen_at: '2026-09-21T10:00:00.000Z',
    last_updated_at: '2026-09-21T11:30:00.000Z',
    ...overrides,
  }
}

describe('POST /api/analytics/token', () => {
  it('returns 200 success:true with empty data (never 404)', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    query.mockResolvedValueOnce({ rows: [] })
    getUsdPrices.mockResolvedValue({ prices: {}, unpriced: ['ghost'] })

    const response = await POST(
      post({ tokenAddresses: ['ghost'], maxAge: 0 }),
    )
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data).toEqual([])
    expect(body.missing).toEqual([{ token_address: 'ghost', reason: 'not_found' }])
    const sql = String(query.mock.calls[0][0])
    expect(sql).not.toMatch(/last_updated_at >=/)
  })

  it('applies last_updated_at cutoff when maxAge is 60', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    query.mockResolvedValueOnce({ rows: [] })
    getUsdPrices.mockResolvedValue({ prices: {}, unpriced: [] })

    await POST(post({ tokenAddresses: ['a'], maxAge: 60 }))
    const sql = String(query.mock.calls[0][0])
    expect(sql).toMatch(/last_updated_at >= \$2/)
  })

  it('returns partial data + missing for mixed batches', async () => {
    query.mockResolvedValueOnce({ rows: [mcapRow('have')] })
    query.mockResolvedValueOnce({ rows: [] })
    getUsdPrices.mockResolvedValue({
      prices: { have: 0.001 },
      unpriced: ['ghost'],
    })

    const response = await POST(
      post({ tokenAddresses: ['have', 'ghost'], maxAge: 0 }),
    )
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].token_address).toBe('have')
    expect(body.missing).toEqual([{ token_address: 'ghost', reason: 'not_found' }])
  })

  it('soft-fails getUsdPrices reject and still returns 200 with mcap enrich', async () => {
    query.mockResolvedValueOnce({ rows: [mcapRow('have')] })
    query.mockResolvedValueOnce({ rows: [] })
    getUsdPrices.mockRejectedValue(new Error('jup down'))

    const response = await POST(
      post({ tokenAddresses: ['have'], maxAge: 0 }),
    )
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].current_price_usd).toBe(0)
  })

  it('does not call price.jup.ag', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    query.mockResolvedValueOnce({ rows: [mcapRow('have')] })
    query.mockResolvedValueOnce({ rows: [] })
    getUsdPrices.mockResolvedValue({ prices: {}, unpriced: ['have'] })

    await POST(post({ tokenAddresses: ['have'], maxAge: 0 }))
    expect(getUsdPrices).toHaveBeenCalled()
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).not.toContain('price.jup.ag')
    }
    vi.unstubAllGlobals()
  })
})
