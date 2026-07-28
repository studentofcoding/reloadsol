import { describe, expect, it } from 'vitest'
import {
  nextCloseProtocolAfterEmpty,
  resolvePoolMintProtocol,
} from './rh-clmm-pool-protocol'

describe('rh-clmm-pool-protocol', () => {
  it('maps univ4 / bytes32 poolId to v4', () => {
    expect(resolvePoolMintProtocol('0xabc', 'univ4')).toBe('v4')
    expect(resolvePoolMintProtocol('0xabc', 'v4')).toBe('v4')
    const poolId =
      '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    expect(resolvePoolMintProtocol(poolId)).toBe('v4')
  })

  it('maps univ3 / 20-byte address to v3', () => {
    expect(
      resolvePoolMintProtocol('0x0123456789abcdef0123456789abcdef01234567', 'univ3'),
    ).toBe('v3')
    expect(
      resolvePoolMintProtocol('0x0123456789abcdef0123456789abcdef01234567'),
    ).toBe('v3')
  })

  it('retries v4 only after a failed v3 already-empty close', () => {
    expect(nextCloseProtocolAfterEmpty('v3')).toBe('v4')
    expect(nextCloseProtocolAfterEmpty('v4')).toBeNull()
  })
})
