import { describe, expect, it } from 'vitest'
import { compactDustOnlyDefault } from './reload-home'

describe('compactDustOnlyDefault', () => {
  it('is dust-only on Solana', () => {
    expect(compactDustOnlyDefault('sol')).toBe(true)
  })

  it('is all sellable on Robinhood', () => {
    expect(compactDustOnlyDefault('robinhood')).toBe(false)
  })
})
