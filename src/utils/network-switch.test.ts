import { describe, expect, it } from 'vitest'
import {
  chainSwitchTarget,
  shouldApplyUrlNetworkToStore,
} from './network-switch'

describe('shouldApplyUrlNetworkToStore', () => {
  it('applies the URL chain on first settle when stored network differs', () => {
    // Direct land on /buy/robinhood with stored sol (incl. non-dev Rabby).
    expect(
      shouldApplyUrlNetworkToStore({
        urlNetwork: 'robinhood',
        storedNetwork: 'sol',
        alreadyApplied: false,
      }),
    ).toBe(true)
    expect(
      shouldApplyUrlNetworkToStore({
        urlNetwork: 'sol',
        storedNetwork: 'robinhood',
        alreadyApplied: false,
      }),
    ).toBe(true)
  })

  it('does not write when URL and store already match', () => {
    expect(
      shouldApplyUrlNetworkToStore({
        urlNetwork: 'sol',
        storedNetwork: 'sol',
        alreadyApplied: false,
      }),
    ).toBe(false)
    expect(
      shouldApplyUrlNetworkToStore({
        urlNetwork: 'robinhood',
        storedNetwork: 'robinhood',
        alreadyApplied: false,
      }),
    ).toBe(false)
  })

  it('does not snap back after a header toggle while the old page is mounted', () => {
    // /buy/solana mounted, store already settled to sol.
    const first = shouldApplyUrlNetworkToStore({
      urlNetwork: 'sol',
      storedNetwork: 'sol',
      alreadyApplied: false,
    })
    expect(first).toBe(false)

    // Header toggle: setNetwork('robinhood') then router.push('/buy/robinhood').
    // The still-mounted sol NetworkPreface must not write sol back.
    expect(
      shouldApplyUrlNetworkToStore({
        urlNetwork: 'sol',
        storedNetwork: 'robinhood',
        alreadyApplied: true,
      }),
    ).toBe(false)

    // Reverse: /sell/robinhood still mounted after toggle to sol.
    expect(
      shouldApplyUrlNetworkToStore({
        urlNetwork: 'robinhood',
        storedNetwork: 'sol',
        alreadyApplied: true,
      }),
    ).toBe(false)
  })
})

describe('chainSwitchTarget', () => {
  it('stays on buy/sell/swap when toggling Sol↔RH', () => {
    expect(chainSwitchTarget('/buy/solana', 'robinhood')).toBe('/buy/robinhood')
    expect(chainSwitchTarget('/buy/robinhood', 'sol')).toBe('/buy/solana')
    expect(chainSwitchTarget('/sell/robinhood', 'sol')).toBe('/sell/solana')
    expect(chainSwitchTarget('/sell/solana', 'robinhood')).toBe(
      '/sell/robinhood',
    )
    expect(chainSwitchTarget('/swap/solana', 'robinhood')).toBe(
      '/swap/robinhood',
    )
    expect(chainSwitchTarget('/swap', 'sol')).toBe('/swap/solana')
  })
})
