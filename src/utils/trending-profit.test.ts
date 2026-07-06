import { describe, expect, it } from 'vitest'
import {
  getSummaryTokenGainPct,
  isSkippedTrackerToken,
  resolveCompletedOutcome,
  sumSummaryTokenProfitPct,
} from './trending-profit'

describe('trending-profit', () => {
  it('uses current gain when token peaked higher then retraced', () => {
    const token = {
      current_gain_percentage: 40,
      peak_gain_percentage: 150,
      status: 'won',
    }
    expect(getSummaryTokenGainPct(token)).toBe(40)
  })

  it('uses current gain for losers', () => {
    expect(
      getSummaryTokenGainPct({
        current_gain_percentage: -60,
        peak_gain_percentage: 20,
        status: 'lost',
      }),
    ).toBe(-60)
  })

  it('uses current gain for open tracking tokens', () => {
    expect(
      getSummaryTokenGainPct({
        current_gain_percentage: 25,
        peak_gain_percentage: 30,
        status: 'tracking',
      }),
    ).toBe(25)
  })

  it('sumSummaryTokenProfitPct aggregates current gains only', () => {
    const result = sumSummaryTokenProfitPct([
      { current_gain_percentage: 40, peak_gain_percentage: 150 },
      { current_gain_percentage: -10, peak_gain_percentage: 50 },
      { current_gain_percentage: 25, peak_gain_percentage: 25 },
    ])
    expect(result.totalProfitPct).toBe(55)
    expect(result.averageProfitPct).toBe(18.33)
    expect(result.tokenCount).toBe(3)
  })

  it('resolveCompletedOutcome returns lost when status won but current gain negative', () => {
    expect(
      resolveCompletedOutcome({
        status: 'won',
        current_gain_percentage: -6.5,
        peak_gain_percentage: 3.57,
      }),
    ).toBe('lost')
  })

  it('resolveCompletedOutcome returns null for skipped', () => {
    expect(
      resolveCompletedOutcome({
        status: 'skipped',
        current_gain_percentage: 85,
      }),
    ).toBe(null)
    expect(isSkippedTrackerToken({ status: 'skipped' })).toBe(true)
  })

  it('resolveCompletedOutcome returns null for still tracking', () => {
    expect(
      resolveCompletedOutcome({
        status: 'tracking',
        current_gain_percentage: 5,
      }),
    ).toBe(null)
  })

  it('resolveCompletedOutcome returns won when current gain positive', () => {
    expect(
      resolveCompletedOutcome({
        status: 'won',
        current_gain_percentage: 12,
      }),
    ).toBe('won')
  })
})
