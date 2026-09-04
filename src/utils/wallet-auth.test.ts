import { beforeEach, describe, expect, it, vi } from 'vitest'

const seen = new Set<string>()

vi.mock('@/utils/redis-cache', () => ({
  cacheSetNx: async (key: string) => {
    if (seen.has(key)) return false
    seen.add(key)
    return true
  },
}))

import { consumeSignInNonce } from './wallet-auth'

describe('consumeSignInNonce', () => {
  beforeEach(() => {
    seen.clear()
  })

  it('accepts a nonce once and rejects replay', async () => {
    const nonce = 'a'.repeat(32)
    expect(await consumeSignInNonce(nonce)).toBe(true)
    expect(await consumeSignInNonce(nonce)).toBe(false)
  })

  it('rejects a malformed nonce', async () => {
    expect(await consumeSignInNonce('short')).toBe(false)
  })
})
