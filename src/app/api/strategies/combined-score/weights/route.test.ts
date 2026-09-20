import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('next/server')>()
  return { ...original, connection: vi.fn(async () => {}) }
})

vi.mock('@/strategies/combined-score-weights', () => ({
  loadCombinedScoreWeights: vi.fn(),
  saveCombinedScoreWeights: vi.fn(),
  resetCombinedScoreWeights: vi.fn(),
}))

import { NextRequest } from 'next/server'
import { GET, PATCH } from '@/app/api/strategies/combined-score/weights/route'
import {
  loadCombinedScoreWeights,
  resetCombinedScoreWeights,
  saveCombinedScoreWeights,
} from '@/strategies/combined-score-weights'

afterEach(() => {
  vi.clearAllMocks()
})

const DEFAULTS = {
  principal: 0.55,
  adjusterPresence: 0.2,
  jaccard: 0.15,
  ohlcPattern: 0.1,
}

describe('GET /api/strategies/combined-score/weights', () => {
  it('returns live weights and defaults', async () => {
    vi.mocked(loadCombinedScoreWeights).mockResolvedValue({
      weights: DEFAULTS,
      source: 'defaults',
    })
    const response = await GET()
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.weights).toEqual(DEFAULTS)
    expect(body.defaults.principal).toBe(0.55)
    expect(body.source).toBe('defaults')
    expect(body.rule).toMatch(/renormalized/)
  })
})

describe('PATCH /api/strategies/combined-score/weights', () => {
  it('saves operator weights', async () => {
    vi.mocked(saveCombinedScoreWeights).mockResolvedValue({
      ok: true,
      weights: DEFAULTS,
      renormalized: true,
      sumBefore: 100,
    })
    const request = new NextRequest(
      'http://localhost/api/strategies/combined-score/weights',
      {
        method: 'PATCH',
        body: JSON.stringify({
          weights: { principal: 55, adjusterPresence: 20, jaccard: 15, ohlcPattern: 10 },
        }),
      },
    )
    const response = await PATCH(request)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.renormalized).toBe(true)
    expect(vi.mocked(saveCombinedScoreWeights)).toHaveBeenCalled()
  })

  it('rejects invalid weights with 400', async () => {
    vi.mocked(saveCombinedScoreWeights).mockResolvedValue({
      ok: false,
      error: 'principal must be ≥ 0',
    })
    const request = new NextRequest(
      'http://localhost/api/strategies/combined-score/weights',
      {
        method: 'PATCH',
        body: JSON.stringify({
          weights: { principal: -1, adjusterPresence: 0.2, jaccard: 0.15, ohlcPattern: 0.1 },
        }),
      },
    )
    const response = await PATCH(request)
    const body = await response.json()
    expect(response.status).toBe(400)
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/≥ 0/)
  })

  it('resets to defaults', async () => {
    vi.mocked(resetCombinedScoreWeights).mockResolvedValue({
      ok: true,
      weights: DEFAULTS,
      renormalized: false,
      sumBefore: 1,
    })
    const request = new NextRequest(
      'http://localhost/api/strategies/combined-score/weights',
      {
        method: 'PATCH',
        body: JSON.stringify({ reset: true }),
      },
    )
    const response = await PATCH(request)
    expect(response.status).toBe(200)
    expect(vi.mocked(resetCombinedScoreWeights)).toHaveBeenCalled()
    expect(vi.mocked(saveCombinedScoreWeights)).not.toHaveBeenCalled()
  })
})
