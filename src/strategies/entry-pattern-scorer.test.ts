import { describe, expect, it } from 'vitest'
import { resolvePatternDecisionThreshold, scorePatternBinary } from './entry-pattern-scorer'

describe('scorePatternBinary', () => {
  it('reads p_winner from two-class output', () => {
    const result = scorePatternBinary(new Float32Array([0.3, 0.7]))
    expect(result.pWinner).toBeCloseTo(0.7)
    expect(result.predicted).toBe('winner')
  })

  it('predicts loser below 0.5', () => {
    const result = scorePatternBinary(new Float32Array([0.8, 0.2]))
    expect(result.predicted).toBe('loser')
  })

  it('uses custom decision threshold for predicted label', () => {
    const result = scorePatternBinary(new Float32Array([0.8, 0.4]), 0.35)
    expect(result.predicted).toBe('winner')
  })

  it('reads decision_threshold from model meta', () => {
    expect(
      resolvePatternDecisionThreshold({
        feature_columns: ['a'],
        metrics: { decision_threshold: 0.35 },
      }),
    ).toBe(0.35)
  })
})
