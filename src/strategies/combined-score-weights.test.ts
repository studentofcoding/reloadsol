import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/strategies/db', () => ({
  loadStrategyDefinitionById: vi.fn(),
  upsertStrategyDefinition: vi.fn(),
}))

import { COMBINED_SCORE_WEIGHTS } from '@/strategies/combined-score'
import { loadStrategyDefinitionById, upsertStrategyDefinition } from '@/strategies/db'
import {
  COMBINED_SCORE_WEIGHTS_STRATEGY_ID,
  invalidateCombinedScoreWeightsCache,
  loadCombinedScoreWeights,
  saveCombinedScoreWeights,
} from '@/strategies/combined-score-weights'

afterEach(() => {
  invalidateCombinedScoreWeightsCache()
  vi.clearAllMocks()
})

describe('loadCombinedScoreWeights', () => {
  it('returns defaults when no row is stored', async () => {
    vi.mocked(loadStrategyDefinitionById).mockResolvedValue(null)
    const live = await loadCombinedScoreWeights()
    expect(live.source).toBe('defaults')
    expect(live.weights).toEqual({ ...COMBINED_SCORE_WEIGHTS })
  })

  it('returns stored renormalized weights when the row is valid', async () => {
    vi.mocked(loadStrategyDefinitionById).mockResolvedValue({
      id: COMBINED_SCORE_WEIGHTS_STRATEGY_ID,
      domain: 'mcap_tracker',
      chain: 'sol',
      name: 'Combined score weights',
      description: null,
      config: {
        principal: 70,
        adjusterPresence: 10,
        jaccard: 10,
        ohlcPattern: 10,
      },
      is_active: true,
      execution_mode: 'sim_only',
      version: 1,
      updated_at: '2026-09-20T12:00:00.000Z',
    })
    const live = await loadCombinedScoreWeights()
    expect(live.source).toBe('stored')
    expect(live.weights.principal).toBeCloseTo(0.7)
    expect(live.weights.adjusterPresence).toBeCloseTo(0.1)
  })

  it('falls back to defaults when the stored row is invalid', async () => {
    vi.mocked(loadStrategyDefinitionById).mockResolvedValue({
      id: COMBINED_SCORE_WEIGHTS_STRATEGY_ID,
      domain: 'mcap_tracker',
      chain: 'sol',
      name: 'Combined score weights',
      description: null,
      config: { principal: -4 },
      is_active: true,
      execution_mode: 'sim_only',
      version: 1,
      updated_at: '2026-09-20T12:00:00.000Z',
    })
    const live = await loadCombinedScoreWeights()
    expect(live.source).toBe('defaults')
    expect(live.weights).toEqual({ ...COMBINED_SCORE_WEIGHTS })
  })
})

describe('saveCombinedScoreWeights', () => {
  it('rejects invalid input and does not write', async () => {
    const result = await saveCombinedScoreWeights({
      principal: -1,
      adjusterPresence: 0.2,
      jaccard: 0.15,
      ohlcPattern: 0.1,
    })
    expect(result.ok).toBe(false)
    expect(vi.mocked(upsertStrategyDefinition)).not.toHaveBeenCalled()
  })

  it('writes renormalized weights to strategy_definitions', async () => {
    vi.mocked(upsertStrategyDefinition).mockResolvedValue({ ok: true })
    const result = await saveCombinedScoreWeights({
      principal: 55,
      adjusterPresence: 20,
      jaccard: 15,
      ohlcPattern: 10,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.renormalized).toBe(true)
    expect(result.weights.principal).toBeCloseTo(0.55)
    expect(vi.mocked(upsertStrategyDefinition)).toHaveBeenCalledWith(
      expect.objectContaining({
        id: COMBINED_SCORE_WEIGHTS_STRATEGY_ID,
        domain: 'mcap_tracker',
        config: expect.objectContaining({ principal: expect.any(Number) }),
      }),
    )
  })
})
