import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchJupiterMarketHints = vi.fn()

vi.mock('@/utils/jupiter-metadata', () => ({
  fetchJupiterMarketHints: (mint: string) => fetchJupiterMarketHints(mint),
}))

import {
  resetFreshMarketValueForTests,
  resolveFreshMarketValue,
} from './fresh-market-value'

const MINT = 'DSmp1qi6fAGn9Xj4cztBi8B1UJUBoiADn7QPhfEnsFq6'

describe('resolveFreshMarketValue', () => {
  beforeEach(() => {
    fetchJupiterMarketHints.mockReset()
    resetFreshMarketValueForTests()
  })

  it('returns the live mcap with an observation time at the read', async () => {
    fetchJupiterMarketHints.mockResolvedValue({ mcap: 307_200, usdPrice: 0.0003, volume5m: 1 })
    const before = Date.now()
    const value = await resolveFreshMarketValue(MINT)
    expect(value).not.toBeNull()
    expect(value!.value).toBe(307_200)
    expect(value!.source).toBe('jupiter-v2-search')
    // The whole point: the observation is NOW, not the tracked row's timestamp.
    expect(value!.observedAtMs).toBeGreaterThanOrEqual(before)
    expect(Date.now() - value!.observedAtMs).toBeLessThan(1000)
  })

  it('returns null when the live read fails — a skip, never a stale price', async () => {
    fetchJupiterMarketHints.mockRejectedValue(new Error('upstream down'))
    await expect(resolveFreshMarketValue(MINT)).resolves.toBeNull()
  })

  it('returns null when the upstream has no mcap, rather than falling back', async () => {
    fetchJupiterMarketHints.mockResolvedValue({ mcap: null, usdPrice: 1, volume5m: 1 })
    await expect(resolveFreshMarketValue(MINT)).resolves.toBeNull()
  })

  it('rejects a non-positive mcap', async () => {
    fetchJupiterMarketHints.mockResolvedValue({ mcap: 0, usdPrice: 1, volume5m: 1 })
    await expect(resolveFreshMarketValue(MINT)).resolves.toBeNull()
  })

  it('serves repeat reads from the cache and de-duplicates in flight', async () => {
    fetchJupiterMarketHints.mockResolvedValue({ mcap: 100, usdPrice: 1, volume5m: 1 })
    const [a, b] = await Promise.all([
      resolveFreshMarketValue(MINT),
      resolveFreshMarketValue(MINT),
    ])
    await resolveFreshMarketValue(MINT)
    expect(a!.value).toBe(100)
    expect(b!.value).toBe(100)
    // Three callers in the same tick within the TTL cost ONE upstream read — this is what keeps
    // seven strategies reading one mint in a pass from becoming seven calls.
    expect(fetchJupiterMarketHints).toHaveBeenCalledTimes(1)
  })

  it('returns null for an empty mint without calling upstream', async () => {
    await expect(resolveFreshMarketValue('')).resolves.toBeNull()
    expect(fetchJupiterMarketHints).not.toHaveBeenCalled()
  })
})
