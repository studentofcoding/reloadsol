import { describe, expect, it } from 'vitest'
import { coerceAppNetwork, parseAppNetwork } from './app-network'

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
