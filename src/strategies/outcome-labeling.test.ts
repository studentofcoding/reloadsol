import { describe, expect, it } from 'vitest'
import { applyAutoOutcomeLabels, computeTrainingClass } from '@/strategies/outcome-labeling'

describe('computeTrainingClass', () => {
  it('returns 1 for won trades with pnl >= 50%', () => {
    expect(computeTrainingClass(114, 'won')).toBe(1)
  })

  it('returns 0 for losses or pnl below 20%', () => {
    expect(computeTrainingClass(-10, 'lost')).toBe(0)
    expect(computeTrainingClass(15, 'won')).toBe(0)
  })

  it('returns null for marginal 20-50% wins', () => {
    expect(computeTrainingClass(35, 'won')).toBe(null)
  })
})

describe('applyAutoOutcomeLabels', () => {
  it('sets ml_label and training_class for clear winners', () => {
    const result = applyAutoOutcomeLabels(
      { organic_score: 72, reached_80: true },
      120,
      'won',
    )
    expect(result.training_class).toBe(1)
    expect(result.ml_label).toBe('interesting')
    expect(typeof result.ml_note).toBe('string')
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
