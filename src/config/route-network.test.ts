import { describe, expect, it } from 'vitest'
import {
  defaultPathForNetwork,
  routeSupportsNetwork,
} from './route-network'

describe('routeSupportsNetwork', () => {
  it('allows RH buy/sell/dlmm', () => {
    expect(routeSupportsNetwork('/buy', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/sell', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/dev/dlmm', 'robinhood')).toBe(true)
  })

  it('allows RH swap/history/pnl/signals/strategies', () => {
    expect(routeSupportsNetwork('/swap', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/history', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/pnl', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/dev/signals', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/dev/strategies', 'robinhood')).toBe(true)
  })

  it('rejects remaining sol-only routes on RH', () => {
    expect(routeSupportsNetwork('/dev/algo-tester', 'robinhood')).toBe(false)
    expect(routeSupportsNetwork('/dev/arbitrage', 'robinhood')).toBe(false)
  })

  it('allows sol everywhere in registry', () => {
    expect(routeSupportsNetwork('/swap', 'sol')).toBe(true)
    expect(routeSupportsNetwork('/dev/signals', 'sol')).toBe(true)
    expect(routeSupportsNetwork('/buy', 'sol')).toBe(true)
  })
})

describe('defaultPathForNetwork', () => {
  it('sends both networks to buy', () => {
    expect(defaultPathForNetwork('sol')).toBe('/buy')
    expect(defaultPathForNetwork('robinhood')).toBe('/buy')
  })
})
