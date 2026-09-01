import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fetchWithCache } from '@/utils/portfolio-cache'

const cacheGet = vi.hoisted(() => vi.fn())
const cacheSet = vi.hoisted(() => vi.fn())
const cacheDelByPrefix = vi.hoisted(() => vi.fn())

vi.mock('@/utils/redis-cache', () => ({
  cacheGet: cacheGet,
  cacheSet: cacheSet,
  cacheDel: vi.fn(),
  cacheDelByPrefix: cacheDelByPrefix,
}))

describe('fetchWithCache', () => {
  beforeEach(() => {
    cacheGet.mockReset()
    cacheSet.mockReset()
    cacheDelByPrefix.mockReset()
  })

  const base = {
    key: 'pf:sol:wallet:holdings',
    staleKey: 'pf:sol:wallet:holdings:stale',
    ttlSeconds: 15,
    staleTtlSeconds: 120,
  }

  it('serves a fresh HIT from cache without calling upstream', async () => {
    cacheGet.mockResolvedValueOnce({ totalValue: 5 })
    const upstream = vi.fn()
    const result = await fetchWithCache({ ...base, fetch: upstream })

    expect(result).toEqual({ data: { totalValue: 5 }, origin: 'hit' })
    expect(upstream).not.toHaveBeenCalled()
    expect(cacheSet).not.toHaveBeenCalled()
  })

  it('fetches on MISS and writes fresh + stale keys', async () => {
    cacheGet.mockResolvedValueOnce(null)
    const upstream = vi.fn().mockResolvedValue({ totalValue: 9 })
    const result = await fetchWithCache({ ...base, fetch: upstream })

    expect(result).toEqual({ data: { totalValue: 9 }, origin: 'miss' })
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(cacheSet).toHaveBeenCalledTimes(2)
    expect(cacheSet).toHaveBeenCalledWith(
      'pf:sol:wallet:holdings',
      { totalValue: 9 },
      15,
    )
  })

  it('serves a STALE snapshot when upstream fails', async () => {
    cacheGet.mockResolvedValueOnce(null) // fresh miss
    cacheGet.mockResolvedValueOnce({ totalValue: 3 }) // stale hit
    const upstream = vi.fn().mockRejectedValue(new Error('upstream down'))
    const result = await fetchWithCache({ ...base, fetch: upstream })

    expect(result).toEqual({ data: { totalValue: 3 }, origin: 'stale' })
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('rethrows when there is no cache and upstream fails', async () => {
    cacheGet.mockResolvedValueOnce(null)
    cacheGet.mockResolvedValueOnce(null)
    const upstream = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(fetchWithCache({ ...base, fetch: upstream })).rejects.toThrow(
      'boom',
    )
  })

  it('skipCache purges keys and always fetches upstream', async () => {
    const upstream = vi.fn().mockResolvedValue({ totalValue: 1 })
    const result = await fetchWithCache({ ...base, fetch: upstream, skipCache: true })

    expect(cacheDelByPrefix).toHaveBeenCalledWith('pf:sol:wallet:holdings:')
    expect(cacheGet).not.toHaveBeenCalled()
    expect(cacheSet).not.toHaveBeenCalled()
    expect(result).toEqual({ data: { totalValue: 1 }, origin: 'miss' })
  })

  it('a Redis GET blip degrades to a plain live fetch (no crash)', async () => {
    cacheGet.mockRejectedValueOnce(new Error('redis down'))
    const upstream = vi.fn().mockResolvedValue({ totalValue: 7 })
    const result = await fetchWithCache({ ...base, fetch: upstream })

    expect(result).toEqual({ data: { totalValue: 7 }, origin: 'miss' })
    expect(upstream).toHaveBeenCalledTimes(1)
  })
})