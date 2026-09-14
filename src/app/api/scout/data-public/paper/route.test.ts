import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('next/server')>()
  return { ...original, connection: vi.fn(async () => {}) }
})

vi.mock('@/strategies/buybulk-datapublic-scout-notches', () => ({
  listBuybulkPaperNotches: vi.fn(),
  insertBuybulkPaperNotch: vi.fn(),
}))

import { NextRequest } from 'next/server'
import { GET, POST } from '@/app/api/scout/data-public/paper/route'
import { resetClimateCache } from '@/utils/climateGate'
import {
  insertBuybulkPaperNotch,
  listBuybulkPaperNotches,
} from '@/strategies/buybulk-datapublic-scout-notches'
import { BUYBULK_DATAPUBLIC_SCOUT_ID } from '@/utils/data-public-scout'

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function post(body: unknown) {
  return POST(
    new NextRequest('http://localhost/api/scout/data-public/paper', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

describe('GET /api/scout/data-public/paper', () => {
  it('lists DB notches stamped with buybulk-datapublic-scout', async () => {
    vi.mocked(listBuybulkPaperNotches).mockResolvedValue([
      {
        key: 'robinhood:0xabc',
        strategyId: BUYBULK_DATAPUBLIC_SCOUT_ID,
        chain: 'robinhood',
        mint: '0xabc',
        symbol: 'ABC',
        name: 'Abc',
        kind: 'vetted',
        decision: 'surfaced',
        score: 70,
        notedAt: 1,
        climateLabel: 'Safe',
        source: BUYBULK_DATAPUBLIC_SCOUT_ID,
      },
    ])
    const body = await (await GET()).json()
    expect(body.ok).toBe(true)
    expect(body.strategyId).toBe('buybulk-datapublic-scout')
    expect(body.notches).toHaveLength(1)
  })
})

describe('POST /api/scout/data-public/paper climate gate', () => {
  it('writes a DB row when climate display is Safe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(climateJson({ state: 'Range' }))),
    )
    vi.mocked(insertBuybulkPaperNotch).mockResolvedValue({
      ok: true,
      created: true,
      notch: {
        key: 'solana:somint',
        strategyId: BUYBULK_DATAPUBLIC_SCOUT_ID,
        chain: 'solana',
        mint: 'SoMint',
        symbol: 'SOLG',
        name: 'Sol Good',
        kind: 'vetted',
        decision: 'surfaced',
        score: 60,
        notedAt: 1,
        climateLabel: 'Safe',
        source: BUYBULK_DATAPUBLIC_SCOUT_ID,
      },
    })

    const response = await post({
      chain: 'solana',
      mint: 'SoMint',
      symbol: 'SOLG',
      name: 'Sol Good',
      kind: 'vetted',
      decision: 'surfaced',
      score: 60,
    })
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.strategyId).toBe('buybulk-datapublic-scout')
    expect(vi.mocked(insertBuybulkPaperNotch).mock.calls[0]?.[0].climateLabel).toBe('Safe')
    expect(JSON.stringify(body)).not.toMatch(/executeBulkBuy/)
  })

  it('returns 403 and does not insert when climate is Cash / Not safe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(climateJson({ state: 'Cash' }))),
    )
    const response = await post({ chain: 'robinhood', mint: '0xabc' })
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.ok).toBe(false)
    expect(body.reason).toBe('climate_not_safe')
    expect(insertBuybulkPaperNotch).not.toHaveBeenCalled()
  })

  it('returns 403 when climate fetch fails (Unknown — observe only)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'nope' }, 503)),
    )
    const response = await post({ chain: 'robinhood', mint: '0xabc' })
    expect(response.status).toBe(403)
    expect(insertBuybulkPaperNotch).not.toHaveBeenCalled()
  })
})
