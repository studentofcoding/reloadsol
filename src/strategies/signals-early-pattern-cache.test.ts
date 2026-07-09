import { afterEach, describe, expect, it } from 'vitest'
import {
  formatPatternShadowLabel,
  resetStage1PatternCacheForTests,
} from './signals-early-pattern-cache'

afterEach(() => {
  resetStage1PatternCacheForTests()
})

describe('formatPatternShadowLabel', () => {
  it('formats pWinner and predicted', () => {
    expect(formatPatternShadowLabel({ pWinner: 0.42, predicted: 'loser' })).toBe(
      'pW 0.42 → loser',
    )
    expect(formatPatternShadowLabel({ pWinner: 0.71, predicted: 'winner' })).toBe(
      'pW 0.71 → winner',
    )
  })

  it('returns n/a when missing', () => {
    expect(formatPatternShadowLabel({ pWinner: null })).toBe('n/a')
    expect(formatPatternShadowLabel({})).toBe('n/a')
  })
})
