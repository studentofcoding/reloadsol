import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gmgnLaneSizes, gmgnMinIntervalMs, gmgnRateGate } from '@/utils/gmgn-api'

describe('GMGN priority lanes', () => {
  beforeEach(() => {
    // 20ms spacing keeps the test fast while still forcing a wait.
    process.env.GMGN_MAX_REQ_PER_SEC = '50'
  })

  afterEach(() => {
    delete process.env.GMGN_MAX_REQ_PER_SEC
  })

  it('serves high before low when both wait behind the interval', async () => {
    expect(gmgnMinIntervalMs()).toBe(20)

    const order: string[] = []
    // First call is dispatched immediately and arms the interval.
    await gmgnRateGate('normal').then(() => order.push('first'))
    // These two land while the gate is waiting → ordered by lane, not arrival.
    const low = gmgnRateGate('low').then(() => order.push('low'))
    const high = gmgnRateGate('high').then(() => order.push('high'))
    await Promise.all([low, high])

    expect(order).toEqual(['first', 'high', 'low'])
  })

  it('reports empty lanes once drained', async () => {
    await Promise.all([
      gmgnRateGate('high'),
      gmgnRateGate('normal'),
      gmgnRateGate('low'),
    ])
    expect(gmgnLaneSizes()).toEqual({ high: 0, normal: 0, low: 0 })
  })
})
