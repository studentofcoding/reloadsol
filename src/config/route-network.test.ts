import { describe, expect, it } from 'vitest'
import {
  defaultPathForNetwork,
  routeSupportsNetwork,
} from './route-network'

describe('routeSupportsNetwork', () => {
  it('allows RH buy/sell/swap/history/pnl/dev/search-token', () => {
    expect(routeSupportsNetwork('/buy', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/buy/solana', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/buy/robinhood', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/sell', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/sell/solana', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/sell/robinhood', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/swap', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/swap/solana', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/swap/robinhood', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/history', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/pnl', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/dev/search-token', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/dev/search-token/solana', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/dev/search-token/robinhood', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/dev/search-token/detail', 'robinhood')).toBe(true)
  })

  it('treats /dev/search-token as a network-agnostic dev route', () => {
    expect(routeSupportsNetwork('/dev/search-token', 'sol')).toBe(true)
    expect(routeSupportsNetwork('/dev/search-token', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/dev/search-token/detail', 'sol')).toBe(true)
  })

  it('allows the strategy hubs on RH; keeps sol-only hubs closed', () => {
    expect(routeSupportsNetwork('/dev/dlmm', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/dev/signals', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/dev/strategies', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/dev/algo-tester', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/dev/social', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/dev/fomo', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/dev/token-search', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/dev/search-token', 'robinhood')).toBe(true)
    expect(routeSupportsNetwork('/dev/arbitrage', 'robinhood')).toBe(false)
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
