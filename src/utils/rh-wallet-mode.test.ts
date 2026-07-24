import { describe, expect, it } from 'vitest'
import {
  GMGN_PARENT_FROM_SUPPORTED,
  parseRhWalletMode,
  resolveRhActiveAddress,
} from './rh-wallet-mode'

describe('rh-wallet-mode', () => {
  it('defaults to parent; accepts bound', () => {
    expect(parseRhWalletMode(null)).toBe('parent')
    expect(parseRhWalletMode('bound')).toBe('bound')
    expect(parseRhWalletMode('parent')).toBe('parent')
  })

  it('resolves active address by mode', () => {
    expect(
      resolveRhActiveAddress('parent', '0xParent', '0xBound'),
    ).toBe('0xParent')
    expect(resolveRhActiveAddress('parent', null, '0xBound')).toBe(null)
    expect(
      resolveRhActiveAddress('bound', '0xParent', '0xBound'),
    ).toBe('0xBound')
    expect(resolveRhActiveAddress('bound', '0xParent', null)).toBe(null)
  })

  it('documents spike: GMGN parent from not supported for swap', () => {
    expect(GMGN_PARENT_FROM_SUPPORTED).toBe(false)
  })
})
