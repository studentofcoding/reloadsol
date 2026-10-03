import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, unknown>()
vi.mock('@/utils/redis-cache', () => ({
  cacheGet: vi.fn(async (k: string) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null)),
  cacheSet: vi.fn(async (k: string, v: unknown) => {
    store.set(k, v)
  }),
}))

const { searchJupiterAssets, parseAssetSearchBackoffS, __resetJupiterAssetSearchForTests } = await import(
  './jupiter-asset-search'
)

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('jupiter asset search proxy', () => {
  beforeEach(() => {
    store.clear()
    __resetJupiterAssetSearchForTests()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-03T00:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('caches by query: second call within TTL does not hit upstream', async () => {
    const f = vi.fn(async () => ok([{ id: 'a' }]))
    vi.stubGlobal('fetch', f)
    const a = await searchJupiterAssets('bonk')
    const b = await searchJupiterAssets(' BONK ')
    expect(a).toMatchObject({ ok: true, cache: 'miss' })
    expect(b).toMatchObject({ ok: true, cache: 'hit', data: [{ id: 'a' }] })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('dedupes concurrent identical queries into one upstream call', async () => {
    const f = vi.fn(async () => ok([1]))
    vi.stubGlobal('fetch', f)
    await Promise.all([searchJupiterAssets('sol'), searchJupiterAssets('sol'), searchJupiterAssets('sol')])
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('refetches after the fresh TTL', async () => {
    const f = vi.fn(async () => ok([1]))
    vi.stubGlobal('fetch', f)
    await searchJupiterAssets('sol')
    vi.setSystemTime(Date.now() + 46_000)
    await searchJupiterAssets('sol')
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('429 with no cached answer → clean 429 + Retry-After, then no upstream during backoff', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 429, headers: { 'retry-after': '20' } }))
    vi.stubGlobal('fetch', f)
    const r1 = await searchJupiterAssets('x')
    expect(r1).toEqual({ ok: false, status: 429, retryAfterS: 20 })
    const r2 = await searchJupiterAssets('y') // different query, still backed off
    expect(r2).toMatchObject({ ok: false, status: 429 })
    expect(f).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 21_000)
    f.mockResolvedValueOnce(ok(['fine']))
    expect(await searchJupiterAssets('y')).toMatchObject({ ok: true, cache: 'miss' })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('429 with a stale answer → serves it (stale) instead of failing', async () => {
    const f = vi.fn().mockResolvedValueOnce(ok(['v1']))
    vi.stubGlobal('fetch', f)
    await searchJupiterAssets('doge')
    vi.setSystemTime(Date.now() + 120_000)
    f.mockResolvedValueOnce(new Response('{}', { status: 429 }))
    const r = await searchJupiterAssets('doge')
    expect(r).toEqual({ ok: true, status: 200, data: ['v1'], cache: 'stale' })
  })

  it('upstream 5xx / network error: stale if any, else a clean error', async () => {
    const f = vi.fn().mockResolvedValue(new Response('boom', { status: 503 }))
    vi.stubGlobal('fetch', f)
    expect(await searchJupiterAssets('q')).toMatchObject({ ok: false, status: 502 })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await searchJupiterAssets('q2')).toMatchObject({ ok: false, status: 500 })
  })

  it('parseAssetSearchBackoffS clamps and defaults', () => {
    const now = Date.parse('2026-10-03T00:00:00Z')
    expect(parseAssetSearchBackoffS(null, now)).toBe(30)
    expect(parseAssetSearchBackoffS('1', now)).toBe(5)
    expect(parseAssetSearchBackoffS('9999', now)).toBe(120)
    expect(parseAssetSearchBackoffS('45', now)).toBe(45)
    expect(parseAssetSearchBackoffS('Sat, 03 Oct 2026 00:00:50 GMT', now)).toBe(50)
    expect(parseAssetSearchBackoffS('junk', now)).toBe(30)
  })
})
