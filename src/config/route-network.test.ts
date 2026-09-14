import { describe, expect, it } from 'vitest'
import {
  connectedSellPath,
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
  it('lands each network on its sell route', () => {
    expect(defaultPathForNetwork('sol')).toBe('/sell/solana')
    expect(defaultPathForNetwork('robinhood')).toBe('/sell/robinhood')
  })
})

describe('connectedSellPath', () => {
  it('keeps unauthenticated users on home (no redirect)', () => {
    expect(connectedSellPath(false, false, 'sol')).toBeNull()
    expect(connectedSellPath(false, false, 'robinhood')).toBeNull()
  })

  it('sends a Solana-only connect to /sell/solana', () => {
    expect(connectedSellPath(true, false, 'sol')).toBe('/sell/solana')
    expect(connectedSellPath(true, false, 'robinhood')).toBe('/sell/solana')
  })

  it('sends a Robinhood-only connect to /sell/robinhood', () => {
    expect(connectedSellPath(false, true, 'sol')).toBe('/sell/robinhood')
    expect(connectedSellPath(false, true, 'robinhood')).toBe('/sell/robinhood')
  })

  it('when both wallets are connected, follows the active app network', () => {
    expect(connectedSellPath(true, true, 'sol')).toBe('/sell/solana')
    expect(connectedSellPath(true, true, 'robinhood')).toBe('/sell/robinhood')
  })
})
