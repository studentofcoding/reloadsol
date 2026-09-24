import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginTradeInFlight,
  dismissTradeInFlight,
  getTradeInFlightView,
  resetTradeInFlightForTests,
} from '@/utils/trade-inflight'

describe('trade inflight overlay state', () => {
  afterEach(() => {
    resetTradeInFlightForTests()
    vi.unstubAllGlobals()
  })

  it('does nothing on the server', () => {
    beginTradeInFlight().succeed()
    expect(getTradeInFlightView()).toBeNull()
  })

  it('stays confirming until the outer flight settles', () => {
    vi.stubGlobal('window', {})
    const outer = beginTradeInFlight()
    const inner = beginTradeInFlight()
    expect(getTradeInFlightView()?.phase).toBe('confirming')
    inner.succeed()
    expect(getTradeInFlightView()?.title).toBe('Confirming trade…')
    outer.succeed()
    expect(getTradeInFlightView()).toMatchObject({
      phase: 'success',
      title: 'Trade confirmed',
    })
  })

  it('ignores dismiss while a trade is still confirming', () => {
    vi.stubGlobal('window', {})
    const flight = beginTradeInFlight()
    dismissTradeInFlight()
    expect(getTradeInFlightView()?.phase).toBe('confirming')
    flight.fail('route rejected')
    dismissTradeInFlight()
    expect(getTradeInFlightView()).toBeNull()
  })
})
