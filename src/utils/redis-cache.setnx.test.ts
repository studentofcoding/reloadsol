import { describe, expect, it } from 'vitest'
import { cacheSetNx } from './redis-cache'

describe('cacheSetNx', () => {
  it('returns false on the second write of the same key', async () => {
    const key = `test-setnx-${Date.now()}-${Math.random()}`
    expect(await cacheSetNx(key, 1, 30)).toBe(true)
    expect(await cacheSetNx(key, 2, 30)).toBe(false)
  })
})
