import { describe, expect, it } from 'vitest'
import { buildEvalDecision } from './eval-engine'
import {
  applyActualToPrediction,
  actualWinFromOutcome,
  buildPredictionFromDecision,
  predictedWinFromScores,
  scoreForPrediction,
  summarizeRunAccuracy,
} from './eval-predictions'

describe('prediction helpers', () => {
  it('prefers mlScore then combined', () => {
    expect(scoreForPrediction(0.8, 0.2)).toBe(0.8)
    expect(scoreForPrediction(null, 0.4)).toBe(0.4)
    expect(scoreForPrediction(null, null)).toBeNull()
  })

  it('predicts win from mlScore or combined thresholds', () => {
    expect(predictedWinFromScores(0.7, 0.2)).toBe(true)
    expect(predictedWinFromScores(0.2, 0.9)).toBe(false)
    expect(predictedWinFromScores(null, 0.4)).toBe(true)
    expect(predictedWinFromScores(null, 0.2)).toBe(false)
  })

  it('reads actual ml_win from features or training class', () => {
    expect(actualWinFromOutcome({ ml_win: 1 })).toBe(true)
    expect(actualWinFromOutcome({ ml_win: 0 })).toBe(false)
    expect(actualWinFromOutcome({}, 40, 'won')).toBe(true)
    expect(actualWinFromOutcome({}, -10, 'lost')).toBe(false)
    expect(actualWinFromOutcome({}, null, null)).toBeNull()
  })

  it('persists a prediction from a shadow decision', () => {
    const decision = buildEvalDecision({
      mint: 'MintA',
      strategyId: 'mcap_enter_at_80',
      combined: 0.6,
      mlScore: 0.8,
      modelVersion: 'cl-test',
    })
    expect(decision.action).toBe('shadow_predict')
    const pred = buildPredictionFromDecision('run-1', decision)
    expect(pred).not.toBeNull()
    expect(pred?.runId).toBe('run-1')
    expect(pred?.mint).toBe('MintA')
    expect(pred?.strategyId).toBe('mcap_enter_at_80')
    expect(pred?.predictedLabel).toBe('win')
    expect(pred?.predictedMlWin).toBe(true)
    expect(pred?.predictedScore).toBe(0.8)
    expect(pred?.modelVersion).toBe('cl-test')
    expect(pred?.outcomeId).toBeNull()
    expect(pred?.correct).toBeNull()
  })

  it('does not persist skip decisions', () => {
    const decision = buildEvalDecision({
      mint: 'MintA',
      strategyId: 'other',
      combined: 0.9,
      mlScore: 0.9,
    })
    expect(decision.action).toBe('skip')
    expect(buildPredictionFromDecision('run-1', decision)).toBeNull()
  })

  it('persists shadow predictions for low-score and not-eligible decisions', () => {
    const low = buildEvalDecision(
      { mint: 'MintA', strategyId: 'mcap_enter_at_80', combined: 0.1, mlScore: 0.2 },
      { env: { ML_CLOSED_LOOP: '1' } },
    )
    expect(low.action).toBe('shadow_predict')
    expect(low.reason).toBe('low_combined')
    const lowPred = buildPredictionFromDecision('run-1', low)
    expect(lowPred?.predictedMlWin).toBe(false)
    expect(lowPred?.predictedScore).toBe(0.2)

    const ineligible = buildEvalDecision({
      mint: 'MintB',
      strategyId: 'mcap_enter_at_80',
      combined: 0.6,
      mlScore: 0.8,
      eligible: false,
      eligibilityReason: 'out_of_range',
    })
    expect(ineligible.action).toBe('shadow_predict')
    expect(ineligible.reason).toBe('out_of_range')
    expect(buildPredictionFromDecision('run-1', ineligible)?.predictedMlWin).toBe(true)
  })

  it('rolls accuracy when actuals land', () => {
    const winPred = applyActualToPrediction(true, true)
    const missPred = applyActualToPrediction(true, false)
    expect(winPred.correct).toBe(true)
    expect(missPred.correct).toBe(false)
    expect(missPred.actualLabel).toBe('loss')

    const stats = summarizeRunAccuracy(
      [
        { predictedScore: 0.8, actualMlWin: true, correct: true },
        { predictedScore: 0.7, actualMlWin: true, correct: true },
        { predictedScore: 0.55, actualMlWin: false, correct: false },
        { predictedScore: 0.6, actualMlWin: null, correct: null },
      ],
      { runId: 'run-1', candidateCount: 4, predictCount: 4, shadow: true },
    )
    expect(stats.resolved).toBe(3)
    expect(stats.correct).toBe(2)
    expect(stats.accuracy).toBeCloseTo(2 / 3)
    expect(stats.avgPredictedScoreWins).toBeCloseTo(0.75)
    expect(stats.avgPredictedScoreLosses).toBeCloseTo(0.55)
    expect(stats.linkedCount).toBe(3)
  })
})
