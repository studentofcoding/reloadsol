import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./entry-ml-scorer.server', () => ({
  scoreEntryFeaturesShadow: vi.fn(async () => ({
    modelVersions: { gate: 'gate-test', potential: 'pot-test' },
    gate: { pBad: 0.1, pGood: 0.9, predicted: 1 },
    potential: { tier: 2, moonScore: 0.4, probs: [0.1, 0.2, 0.4, 0.2, 0.1] },
  })),
  evaluateMlGateEnforce: vi.fn(async () => ({ reject: false, pBad: 0.1, reason: null })),
}))

vi.mock('./entry-pattern-scorer.server', () => ({
  scorePatternFeaturesShadow: vi.fn(async () => ({
    pattern: { pWinner: 0.55, pLoser: 0.45, predicted: 'winner' as const },
    modelVersion: 'pat-test',
    scoredAt: '2026-01-01T00:00:00Z',
  })),
  evaluatePatternEnforce: vi.fn(async () => ({
    reject: false,
    pWinner: 0.55,
    reason: null,
  })),
}))

describe('attachMlEntryShadow', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('merges gate, potential, and pattern keys into features', async () => {
    const { attachMlEntryShadow } = await import('./ml-entry-shadow')
    const result = await attachMlEntryShadow(
      { entry_mcap: 50_000, organic_score: 70 },
      { enforce: false },
    )
    expect(result.gateReject).toBe(false)
    expect(result.patternReject).toBe(false)
    expect(result.features.ml_gate_p_bad).toBe(0.1)
    expect(result.features.ml_potential_tier).toBe(2)
    expect(result.features.ml_pattern_p_winner).toBe(0.55)
    expect(result.pBad).toBe(0.1)
    expect(result.pWinner).toBe(0.55)
  })

  it('surfaces enforce rejects without dropping shadow fields', async () => {
    const ml = await import('./entry-ml-scorer.server')
    vi.mocked(ml.evaluateMlGateEnforce).mockResolvedValueOnce({
      reject: true,
      pBad: 0.9,
      reason: 'ml_gate_reject',
    })
    const { attachMlEntryShadow } = await import('./ml-entry-shadow')
    const result = await attachMlEntryShadow({ entry_mcap: 1 }, { enforce: true })
    expect(result.gateReject).toBe(true)
    expect(result.gateReason).toBe('ml_gate_reject')
    expect(result.features.ml_gate_p_bad).toBe(0.1)
  })
})
