import { describe, expect, it } from 'vitest'
import {
  defaultPathForNetwork,
  routeSupportsNetwork,
} from './route-network'

describe('routeSupportsNetwork', () => {
  it('allows RH buy/sell/swap/history/pnl', () => {
    expect(routeSupportsNetwork('/buy', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/sell', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/swap', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/history', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/pnl', 'robinhood')).toBe(true)
  })

  it('allows DLMM on RH; hides other RH hubs not wired yet', () => {
    expect(routeSupportsNetwork('/dev/dlmm', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/dev/signals', 'robinhood')).toBe(false)
    expect(routeSupportsNetwork('/dev/strategies', 'robinhood')).toBe(false)
    expect(routeSupportsNetwork('/dev/algo-tester', 'robinhood')).toBe(false)
  })

  it('allows sol everywhere in registry', () => {
    expect(routeSupportsNetwork('/swap', 'sol')).toBe(true)
    expect(routeSupportsNetwork('/dev/signals', 'sol')).toBe(true)
    expect(routeSupportsNetwork('/dev/dlmm', 'sol')).toBe(true)
    expect(routeSupportsNetwork('/buy', 'sol')).toBe(true)
  })
})

describe('defaultPathForNetwork', () => {
  it('sends both networks to buy', () => {
    expect(defaultPathForNetwork('sol')).toBe('/buy')
    expect(defaultPathForNetwork('robinhood')).toBe('/buy')
  })
})
