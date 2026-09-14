import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('next/server')>()
  return { ...original, connection: vi.fn(async () => {}) }
})

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/scout/data-public/route'
import { resetClimateCache } from '@/utils/climateGate'

afterEach(() => {
  resetClimateCache()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function climateJson(overrides: Record<string, unknown> = {}) {
  return {
    h: 0.4,
    c: 0.9,
    state: 'Range',
    cascade: { veto: false },
    missing: ['e5', 'e4_depth'],
    pyth: { configured: true },
    timestamps: { computedAt: Date.now() },
    ...overrides,
  }
}

function feedJson() {
  return {
    generatedAt: 1_700_000_000,
    solDelayMin: 15,
    windowH: 24,
    page: 1,
    pages: 1,
    counts: { rows: 3, rh: 2, sol: 1, surfaced: 2 },
    rows: [
      {
        id: 1,
        ts: 10,
        kind: 'vetted',
        chain: 'robinhood',
        mint: '0xgood',
        symbol: 'GOOD',
        name: 'Good',
        decision: 'surfaced',
        score: 80,
        mcap: 40_000,
        liq: 15_000,
        vetoes: [],
        nameReuse: 0,
      },
      {
        id: 2,
        ts: 11,
        kind: 'vetted',
        chain: 'robinhood',
        mint: '0xwatch',
        symbol: 'WATCH',
        decision: 'watching',
        score: 40,
        liq: 20_000,
        vetoes: [],
      },
      {
        id: 3,
        ts: 12,
        kind: 'vetted',
        chain: 'solana',
        mint: 'SoGood',
        symbol: 'SOLG',
        name: 'Sol Good',
        decision: 'surfaced',
        score: 60,
        mcap: 30_000,
        liq: 12_000,
        vetoes: [],
        nameReuse: 1,
      },
    ],
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockFetch(handler: (input: RequestInfo | URL) => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => handler(input)),
  )
}

function request(chain = 'all') {
  return new NextRequest(`http://localhost/api/scout/data-public?chain=${chain}`)
}

describe('GET /api/scout/data-public', () => {
  it('proxies the feed, applies filters, and attaches climateAtEmit', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.includes('regime/climate')) return jsonResponse(climateJson())
      if (url.includes('data-public') || url.includes('/api/feed')) {
        return jsonResponse(feedJson())
      }
      return jsonResponse({ error: 'unexpected' }, 404)
    })

    const response = await GET(request('all'))
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.climateAtEmit.label).toBe('Safe')
    expect(body.paperAllowed).toBe(true)
    expect(body.solDelayMin).toBe(15)
    expect(body.rows).toHaveLength(2)
    expect(body.rows.map((r: { chain: string }) => r.chain).sort()).toEqual([
      'robinhood',
      'solana',
    ])
    expect(body.disclaimer).toMatch(/Study/)
    expect(JSON.stringify(body)).not.toMatch(/executeBulkBuy/)
  })

  it('keeps the observe list when climate is Not safe but paperAllowed is false', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.includes('regime/climate')) {
        return jsonResponse(climateJson({ state: 'Cash' }))
      }
      return jsonResponse(feedJson())
    })

    const body = await (await GET(request('all'))).json()
    expect(body.climateAtEmit.label).toBe('Not safe')
    expect(body.paperAllowed).toBe(false)
    expect(body.rows.length).toBeGreaterThan(0)
  })

  it('rejects an unknown chain', async () => {
    const response = await GET(request('ethereum'))
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.ok).toBe(false)
  })
})
