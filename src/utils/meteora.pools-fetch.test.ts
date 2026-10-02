import { describe, expect, it, vi, afterEach } from 'vitest'
import { fetchMeteoraPools } from '@/utils/meteora'

afterEach(() => vi.unstubAllGlobals())

const pool = (i: number) => ({ address: `pool${i}`, tvl: 1_000_000 })

function stubApi(rowsPerPage = 10, totalPages = 3) {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(String(url))
      const page = Number(new URL(String(url)).searchParams.get('page') ?? '1')
      const data = page <= totalPages
        ? Array.from({ length: rowsPerPage }, (_, k) => pool(page * 100 + k))
        : []
      return { ok: true, status: 200, json: async () => ({ data, page_size: 10 }) }
    }),
  )
  return urls
}

/**
 * Two measured facts about the live Meteora API (2026-10-02) that this pins:
 *
 *  1. `sort_by=fee_tvl_ratio_24h:desc` returns dust-TVL pools (tvl ~0.000001) — 0 of 10 clear the
 *     screener's min_tvl floor, which is what produced 35 days of `candidateCount: 0`. Sorting by
 *     `tvl:desc` returns the 37.6M / 15.3M / 12.8M pools — 10 of 10 clear it.
 *  2. `limit` is IGNORED: limit=10/50/100/200 all return page_size 10. So one call can never deliver
 *     the requested set and the fetch has to walk pages.
 */
describe('fetchMeteoraPools', () => {
  it('sorts by TVL, never by fee/TVL', async () => {
    const urls = stubApi()
    await fetchMeteoraPools({ limit: 10 })
    expect(urls[0]).toContain('sort_by=tvl%3Adesc')
    expect(urls[0]).not.toContain('fee_tvl_ratio')
  })

  it('walks pages, because the API caps page_size at 10 and ignores limit', async () => {
    const urls = stubApi(10, 3)
    const pools = await fetchMeteoraPools({ limit: 25, skipCache: true })
    expect(urls.length).toBeGreaterThan(1) // it did not stop at one page
    expect(pools.length).toBeGreaterThanOrEqual(25)
  })

  it('stops when a short page arrives', async () => {
    const urls = stubApi(4, 5) // every page is short
    await fetchMeteoraPools({ limit: 50, skipCache: true })
    expect(urls.length).toBe(1)
  })

  it('stops on an empty page rather than looping', async () => {
    const urls = stubApi(10, 0)
    const pools = await fetchMeteoraPools({ limit: 50, skipCache: true })
    expect(urls.length).toBe(1)
    expect(pools).toEqual([])
  })
})
