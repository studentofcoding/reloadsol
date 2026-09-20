import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('next/server')>()
  return { ...original, connection: vi.fn(async () => {}) }
})

vi.mock('@/strategies/combined-score-load', () => ({
  loadCombinedScore: vi.fn(),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/strategies/combined-score/route'
import { loadCombinedScore } from '@/strategies/combined-score-load'
import type { CombinedScoreResponse } from '@/strategies/combined-score'

const MINT = 'So11111111111111111111111111111111111111112'

afterEach(() => {
  vi.restoreAllMocks()
})

function scorePayload(): CombinedScoreResponse {
  return {
    success: true,
    mint: MINT,
    chain: 'sol',
    hours: 24,
    combined: 0.215,
    weights: {
      principal: 0.55,
      adjusterPresence: 0.2,
      jaccard: 0.15,
      ohlcPattern: 0.1,
    },
    parts: {
      principalScore: 0.3,
      adjusterPresenceScore: 0,
      jaccardScore: null,
      ohlcPatternScore: 0.5,
    },
    principals: [
      { strategyId: 'mcap_enter_first_seen', present: true },
      { strategyId: 'mcap_enter_at_80', present: true },
    ],
    adjusters: [
      { domain: 'signals', present: false },
      { domain: 'gmgn', present: false },
      { domain: 'social', present: false },
      { domain: 'trending_bot', present: false },
    ],
    generatedAt: '2026-09-20T12:00:00.000Z',
  }
}

describe('GET /api/strategies/combined-score', () => {
  it('returns success for a valid mint shape', async () => {
    vi.mocked(loadCombinedScore).mockResolvedValue(scorePayload())
    const request = new NextRequest(
      `http://localhost/api/strategies/combined-score?address=${MINT}&chain=sol&hours=24`,
    )
    const response = await GET(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.mint).toBe(MINT)
    expect(body.principals).toHaveLength(2)
    expect(body.weights.principal).toBe(0.55)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(vi.mocked(loadCombinedScore)).toHaveBeenCalledWith({
      address: MINT,
      chain: 'sol',
      hours: 24,
    })
  })

  it('rejects an invalid address', async () => {
    const request = new NextRequest(
      'http://localhost/api/strategies/combined-score?address=not-a-mint',
    )
    const response = await GET(request)
    const body = await response.json()
    expect(response.status).toBe(400)
    expect(body.success).toBe(false)
    expect(vi.mocked(loadCombinedScore)).not.toHaveBeenCalled()
  })

  it('rejects an unknown chain', async () => {
    const request = new NextRequest(
      `http://localhost/api/strategies/combined-score?address=${MINT}&chain=bsc`,
    )
    const response = await GET(request)
    const body = await response.json()
    expect(response.status).toBe(400)
    expect(body.error).toMatch(/sol or robinhood/)
  })
})
