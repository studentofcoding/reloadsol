import { describe, expect, it } from 'vitest'
import { coerceAppNetwork, parseAppNetwork } from './app-network'
import { resolveNetworkOnRhGateChange } from './app-network-gate'

describe('parseAppNetwork', () => {
  it('accepts robinhood', () => {
    expect(parseAppNetwork('robinhood')).toBe('robinhood')
  })

  it('defaults everything else to sol', () => {
    expect(parseAppNetwork('sol')).toBe('sol')
    expect(parseAppNetwork(null)).toBe('sol')
    expect(parseAppNetwork('eth')).toBe('sol')
  })
})

describe('coerceAppNetwork', () => {
  it('allows robinhood when canUseRh', () => {
    expect(coerceAppNetwork('robinhood', true)).toBe('robinhood')
  })

  it('forces sol when !canUseRh', () => {
    expect(coerceAppNetwork('robinhood', false)).toBe('sol')
    expect(coerceAppNetwork('sol', false)).toBe('sol')
  })
})

describe('resolveNetworkOnRhGateChange', () => {
  it('does nothing when gate unchanged', () => {
    expect(
      resolveNetworkOnRhGateChange({
        prevCanUseRh: false,
        canUseRh: false,
        current: 'robinhood',
        stored: 'robinhood',
      }),
    ).toEqual({ network: 'robinhood', shouldWrite: false })
  })

  it('restores stored RH when access granted', () => {
    expect(
      resolveNetworkOnRhGateChange({
        prevCanUseRh: false,
        canUseRh: true,
        current: 'sol',
        stored: 'robinhood',
      }),
    ).toEqual({ network: 'robinhood', shouldWrite: true })
  })

  it('keeps current network when access revoked (URL is source of truth)', () => {
    // /buy/robinhood should still render even if the user disconnected Rabby;
    // the trade gates will block actual execution but the page must not be
    // silently coerced to the Sol branch.
    expect(
      resolveNetworkOnRhGateChange({
        prevCanUseRh: true,
        canUseRh: false,
        current: 'robinhood',
        stored: 'robinhood',
      }),
    ).toEqual({ network: 'robinhood', shouldWrite: false })
  })
})
