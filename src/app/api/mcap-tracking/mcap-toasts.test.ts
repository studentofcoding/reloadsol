import { describe, expect, it } from 'vitest'
import { buildPredictiveToast, computeToastKey } from '@/app/api/mcap-tracking/mcap-toasts'

describe('mcap-toasts', () => {
  it('builds predictive toast with confidence', () => {
    const toast = buildPredictiveToast('TEST', 'addr123', 12.5, {
      isPredictive: true,
      pWinner: 0.72,
      predicted: 'winner',
      modelVersion: 'v1',
      reason: null,
    })

    expect(toast.category).toBe('predictive')
    expect(toast.title).toBe('Predictive Winner Pattern')
    expect(toast.items?.[0]).toMatchObject({
      symbol: 'TEST',
      address: 'addr123',
      pWinner: 0.72,
      predicted: 'winner',
    })
  })

  it('dedup keys include pWinner for predictive alerts', () => {
    const key = computeToastKey(
      'predictive',
      [{ address: 'abc', growthPercent: 0, pWinner: 0.71 }],
      { pWinner: 0.71 },
    )
    expect(key).toContain('predictive')
    expect(key).toContain('abc')
    expect(key).toContain('pw:0.71')
  })
})
