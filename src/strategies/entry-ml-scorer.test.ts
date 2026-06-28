import { describe, expect, it } from 'vitest'
import { featureVectorToTensorInput, scoreBinaryGate } from '@/strategies/entry-ml-scorer'
import { mergeShadowScoresIntoEntryFeatures } from '@/strategies/ml-shadow-log'

describe('featureVectorToTensorInput', () => {
  it('orders values by feature column list', () => {
    const cols = ['a', 'b', 'c']
    const tensor = featureVectorToTensorInput(cols, { b: 2, a: 1, c: 3 })
    expect(Array.from(tensor)).toEqual([1, 2, 3])
  })

  it('fills missing columns with zero', () => {
    const tensor = featureVectorToTensorInput(['x', 'y'], { x: 5 })
    expect(Array.from(tensor)).toEqual([5, 0])
  })
})

describe('scoreBinaryGate', () => {
  it('reads single-output probability as pGood', () => {
    const result = scoreBinaryGate(new Float32Array([0.75]))
    expect(result.pGood).toBe(0.75)
    expect(result.pBad).toBeCloseTo(0.25)
    expect(result.predicted).toBe(1)
  })

  it('reads two-class output index 1 as pGood', () => {
    const result = scoreBinaryGate(new Float32Array([0.3, 0.7]))
    expect(result.pGood).toBeCloseTo(0.7)
    expect(result.predicted).toBe(1)
  })
})

describe('mergeShadowScoresIntoEntryFeatures', () => {
  it('merges gate and potential shadow fields', () => {
    const merged = mergeShadowScoresIntoEntryFeatures(
      { organic_score: 70 },
      {
        gate: { pBad: 0.2, pGood: 0.8, predicted: 1 },
        potential: { tier: 3, probs: { 3: 0.5, 4: 0.1 }, moonScore: 0.6 },
        modelVersions: { gate: 'v2-gate', potential: 'v2-potential' },
        scoredAt: '2026-01-01T00:00:00.000Z',
      },
    )
    expect(merged.organic_score).toBe(70)
    expect(merged.ml_gate_p_bad).toBe(0.2)
    expect(merged.ml_potential_tier).toBe(3)
    expect(merged.ml_shadow_at).toBe('2026-01-01T00:00:00.000Z')
  })

  it('returns input unchanged when shadow is null', () => {
    const base = { entry_mcap: 100_000 }
    expect(mergeShadowScoresIntoEntryFeatures(base, null)).toBe(base)
  })
})
