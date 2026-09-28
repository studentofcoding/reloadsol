import { describe, expect, it } from 'vitest'
import {
  patternRuntimeStatus,
  resolvePatternDecisionThreshold,
  scoreClosedLoopLogistic,
  scorePatternBinary,
} from './entry-pattern-scorer'

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

  it('scores a closed-loop logistic at 0.5 for a zero logit', () => {
    expect(scoreClosedLoopLogistic([0, 0], [0.2, -0.1], 0)).toBeCloseTo(0.5)
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

describe('patternRuntimeStatus', () => {
  it('reports a loaded but not-yet-ready model as loaded (regression)', () => {
    const status = patternRuntimeStatus({
      meta: { feature_columns: ['a'], metrics: { pattern_ready: false } },
      loadError: null,
      modelVersion: 'pattern-gate',
    })
    expect(status.runtime_loaded).toBe(true)
    expect(status.pattern_ready).toBe(false)
    expect(status.model_version).toBe('pattern-gate')
    expect(status.error).toBeNull()
  })

  it('reports a ready model as loaded and ready', () => {
    const status = patternRuntimeStatus({
      meta: { feature_columns: ['a'], metrics: { pattern_ready: true } },
      loadError: null,
      modelVersion: 'pattern-gate',
    })
    expect(status).toMatchObject({
      runtime_loaded: true,
      pattern_ready: true,
      model_version: 'pattern-gate',
      error: null,
    })
  })

  it('surfaces the real load error when no model loaded', () => {
    const status = patternRuntimeStatus({
      meta: null,
      loadError: '/app/ml/artifacts/pattern-gate/model.onnx not found',
      modelVersion: null,
    })
    expect(status.runtime_loaded).toBe(false)
    expect(status.pattern_ready).toBe(false)
    expect(status.model_version).toBeNull()
    expect(status.error).toBe('/app/ml/artifacts/pattern-gate/model.onnx not found')
  })

  it('falls back to a generic error when no load error was recorded', () => {
    const status = patternRuntimeStatus({ meta: null, loadError: null, modelVersion: null })
    expect(status.error).toBe('pattern model not loaded')
  })
})
