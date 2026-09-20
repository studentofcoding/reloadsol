import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('next/server')>()
  return { ...original, connection: vi.fn(async () => {}) }
})

vi.mock('@/strategies/combined-score-load', () => ({
  loadCombinedScore: vi.fn(),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/strategies/ml/score/route'
import { loadCombinedScore } from '@/strategies/combined-score-load'

const MINT = 'So11111111111111111111111111111111111111112'

afterEach(() => {
  delete process.env.ML_CLOSED_LOOP
  vi.clearAllMocks()
})

describe('GET /api/strategies/ml/score', () => {
  it('returns null scores when the flag is off', async () => {
    const request = new NextRequest(
      `http://localhost/api/strategies/ml/score?address=${MINT}`,
    )
    const response = await GET(request)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.mlScore).toBeNull()
    expect(body.modelVersion).toBeNull()
    expect(vi.mocked(loadCombinedScore)).not.toHaveBeenCalled()
  })

  it('returns the model score when the flag is on', async () => {
    process.env.ML_CLOSED_LOOP = '1'
    vi.mocked(loadCombinedScore).mockResolvedValue({
      success: true,
      mint: MINT,
      chain: 'sol',
      hours: 24,
      combined: 0.4,
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
      principals: [],
      adjusters: [],
      mlScore: 0.72,
      modelVersion: 'cl-test',
      generatedAt: '2026-09-20T12:00:00.000Z',
    })
    const request = new NextRequest(
      `http://localhost/api/strategies/ml/score?address=${MINT}`,
    )
    const response = await GET(request)
    const body = await response.json()
    expect(body.mlScore).toBe(0.72)
    expect(body.modelVersion).toBe('cl-test')
  })

  it('rejects an invalid address', async () => {
    const request = new NextRequest('http://localhost/api/strategies/ml/score?address=nope')
    const response = await GET(request)
    expect(response.status).toBe(400)
  })
})
