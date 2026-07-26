import { afterEach, describe, expect, it } from 'vitest'
import {
  canUseRobinhoodNetwork,
  clearRhWhitelistCache,
  isRhWhitelisted,
  normalizeRhWhitelistAddress,
} from '@/utils/rh-whitelist'

describe('rh-whitelist', () => {
  afterEach(() => {
    clearRhWhitelistCache()
    delete process.env.NEXT_PUBLIC_RH_WHITELIST
    delete process.env.RH_WHITELIST
  })

  it('normalizes EVM to lowercase and leaves Sol as-is', () => {
    expect(normalizeRhWhitelistAddress('0xAbC')).toBe('0xabc')
    expect(
      normalizeRhWhitelistAddress('3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX'),
    ).toBe('3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX')
  })

  it('matches Sol or EVM from NEXT_PUBLIC_RH_WHITELIST', () => {
    process.env.NEXT_PUBLIC_RH_WHITELIST =
      '3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX,0xABCDef0123456789ABCDef0123456789ABCDef01'
    clearRhWhitelistCache()
    expect(
      isRhWhitelisted('3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX'),
    ).toBe(true)
    expect(
      isRhWhitelisted('0xabcdef0123456789abcdef0123456789abcdef01'),
    ).toBe(true)
    expect(isRhWhitelisted('not-on-list')).toBe(false)
  })

  it('canUseRobinhoodNetwork unions DEV and whitelist', () => {
    process.env.NEXT_PUBLIC_RH_WHITELIST =
      '0x1111111111111111111111111111111111111111'
    clearRhWhitelistCache()
    expect(
      canUseRobinhoodNetwork({
        solAddress: null,
        evmAddress: '0x1111111111111111111111111111111111111111',
        isDevUser: false,
      }),
    ).toBe(true)
    expect(
      canUseRobinhoodNetwork({
        solAddress: null,
        evmAddress: null,
        isDevUser: true,
      }),
    ).toBe(true)
    expect(
      canUseRobinhoodNetwork({
        solAddress: 'SomeSol',
        evmAddress: null,
        isDevUser: false,
      }),
    ).toBe(false)
  })
})
