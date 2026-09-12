import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cacheGet } from '@/utils/redis-cache'
import {
  chunkMints,
  getUsdPrices,
  parseJupiterPriceV3,
  resetUsdPricesForTests,
  USD_PRICE_IDS_PER_REQUEST,
  usdPriceRedisKey,
} from '@/utils/usd-prices'

const SOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

function mint(i: number): string {
  return `111111111111111111111111111111111111111${String(i).padStart(3, '0')}`
}

describe('chunkMints / parseJupiterPriceV3', () => {
  it('splits 51 mints into two GETs of 50', () => {
    const mints = Array.from({ length: 51 }, (_, i) => mint(i))
    const chunks = chunkMints(mints, USD_PRICE_IDS_PER_REQUEST)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toHaveLength(50)
    expect(chunks[1]).toHaveLength(1)
  })

  it('omitted Jupiter ids are unpriced, not 0', () => {
    const parsed = parseJupiterPriceV3(
      { [SOL]: { usdPrice: 100, decimals: 9 } },
      [SOL, USDC],
    )
    expect(parsed.prices[SOL]).toBe(100)
    expect(parsed.prices[USDC]).toBeUndefined()
    expect(parsed.unpriced).toEqual([USDC])
  })
})

describe('getUsdPrices', () => {
  beforeEach(() => {
    resetUsdPricesForTests()
    process.env.JUPITER_API_KEY = 'test-key'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const ids = new URL(url).searchParams.get('ids')?.split(',') ?? []
        const body: Record<string, { usdPrice: number }> = {}
        for (const id of ids) {
          if (id === USDC) continue
          body[id] = { usdPrice: 1.23 }
        }
        return {
          ok: true,
          status: 200,
          json: async () => body,
        }
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.JUPITER_API_KEY
  })

  it('negative-caches omitted mints as null, not 0', async () => {
    const result = await getUsdPrices([SOL, USDC])
    expect(result.prices[SOL]).toBe(1.23)
    expect(result.unpriced).toContain(USDC)
    expect(result.prices[USDC]).toBeUndefined()

    const cached = await cacheGet<{ price: number | null }>(usdPriceRedisKey(USDC))
    expect(cached?.price).toBeNull()
  })

  it('chunks 51 mints into two Jupiter GETs', async () => {
    const mints = Array.from({ length: 51 }, (_, i) => mint(i))
    await getUsdPrices(mints)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('coalesces overlapping misses onto one Jupiter GET', async () => {
    const overlap = mint(99)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 40))
        return {
          ok: true,
          status: 200,
          json: async () => ({ [overlap]: { usdPrice: 99 } }),
        }
      }),
    )
    await Promise.all([getUsdPrices([overlap]), getUsdPrices([overlap])])
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
