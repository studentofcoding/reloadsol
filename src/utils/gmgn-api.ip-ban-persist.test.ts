import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => new Map<string, unknown>())
vi.mock('./redis-cache', () => ({
  cacheGet: vi.fn(async (k: string) => (store.has(k) ? store.get(k) : null)),
  cacheSet: vi.fn(async (k: string, v: unknown) => {
    store.set(k, v)
  }),
}))

import {
  __markIpBanForTests,
  __resetIpBanHydrationForTests,
  __resetRateLimitCooldownForTests,
  gmgnIpBanRemainingMs,
  hydrateGmgnIpBan,
} from './gmgn-api'

describe('GMGN IP ban survives a restart', () => {
  beforeEach(() => {
    store.clear()
    __resetRateLimitCooldownForTests()
  })

  it('persists a ban and a fresh process (memory cleared) loads it before sending anything', async () => {
    __markIpBanForTests(Math.floor(Date.now() / 1000) + 120)
    await Promise.resolve()
    expect(store.get('gmgn:ip-ban')).toMatchObject({ untilMs: expect.any(Number) })

    // "restart": in-memory ban gone, hydration not yet done
    __resetRateLimitCooldownForTests()
    expect(gmgnIpBanRemainingMs()).toBe(0)
    __resetIpBanHydrationForTests()
    await hydrateGmgnIpBan()
    expect(gmgnIpBanRemainingMs()).toBeGreaterThan(100_000)
  })

  it('no saved ban -> no ban; an expired saved ban is ignored by the remaining-time maths', async () => {
    __resetIpBanHydrationForTests()
    await hydrateGmgnIpBan()
    expect(gmgnIpBanRemainingMs()).toBe(0)
    store.set('gmgn:ip-ban', { untilMs: Date.now() - 5_000 })
    __resetIpBanHydrationForTests()
    await hydrateGmgnIpBan()
    expect(gmgnIpBanRemainingMs()).toBe(0)
  })
})
