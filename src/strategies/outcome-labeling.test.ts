import { describe, expect, it } from 'vitest'
import { applyAutoOutcomeLabels, applyManualTrainingClass, computeTrainingClass } from '@/strategies/outcome-labeling'

describe('computeTrainingClass', () => {
  it('returns 0 for losses and weak wins below 20%', () => {
    expect(computeTrainingClass(-10, 'lost')).toBe(0)
    expect(computeTrainingClass(15, 'won')).toBe(0)
  })

  it('returns 1 for won trades with 20% to 50% pnl', () => {
    expect(computeTrainingClass(20, 'won')).toBe(1)
    expect(computeTrainingClass(35, 'won')).toBe(1)
    expect(computeTrainingClass(49.9, 'won')).toBe(1)
  })

  it('returns tier 2–4 at higher pnl bands', () => {
    expect(computeTrainingClass(50, 'won')).toBe(2)
    expect(computeTrainingClass(80, 'won')).toBe(2)
    expect(computeTrainingClass(100, 'won')).toBe(3)
    expect(computeTrainingClass(150, 'won')).toBe(3)
    expect(computeTrainingClass(300, 'won')).toBe(4)
    expect(computeTrainingClass(400, 'won')).toBe(4)
  })

  it('returns null when pnl missing', () => {
    expect(computeTrainingClass(null, 'won')).toBe(null)
  })
})

describe('applyAutoOutcomeLabels', () => {
  it('sets ml_label and training_class for tier 1 wins', () => {
    const result = applyAutoOutcomeLabels(
      { organic_score: 72, reached_80: true },
      35,
      'won',
    )
    expect(result.training_class).toBe(1)
    expect(result.ml_label).toBe('interesting')
    expect(typeof result.ml_note).toBe('string')
    expect(result.ml_note).toContain('class=1')
  })

  it('sets class 0 for skip tier', () => {
    const result = applyAutoOutcomeLabels({}, -10, 'lost')
    expect(result.training_class).toBe(0)
    expect(result.ml_label).toBe('skip')
  })

  it('skips auto label when ml_manual is set', () => {
    const result = applyAutoOutcomeLabels(
      { ml_manual: true, ml_label: 'anomaly' },
      120,
      'won',
    )
    expect(result.ml_label).toBe('anomaly')
    expect(result.training_class).toBeUndefined()
  })
})

describe('applyManualTrainingClass', () => {
  it('sets skip label for class 0 and ml_manual', () => {
    const result = applyManualTrainingClass({ ml_condition: 'new_chart' }, 0)
    expect(result.training_class).toBe(0)
    expect(result.ml_label).toBe('skip')
    expect(result.ml_manual).toBe(true)
    expect(result.ml_condition).toBe('new_chart')
  })

  it('sets interesting label for class 2 and ml_manual', () => {
    const result = applyManualTrainingClass({}, 2)
    expect(result.training_class).toBe(2)
    expect(result.ml_label).toBe('interesting')
    expect(result.ml_manual).toBe(true)
  })
})
