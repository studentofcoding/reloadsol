import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/strategies/token-info-detect', () => ({
  tokenInfoDetectRowExists: vi.fn(async () => false),
}))

import {
  sampleGmgnWebFullInfo,
  sampleGmgnWebWindow,
} from '@/utils/gmgn-web-multi.fixtures'
import {
  __clearGmgnWebCacheForTests,
  __resetGmgnWebMultiForTests,
  fetchGmgnWebMultiTokenInfo,
  getGmgnWebMultiMetrics,
  mapGmgnWebTokenRow,
} from '@/utils/gmgn-web-multi'

const MINT = 'So11111111111111111111111111111111111111112'
const fetchMock = vi.fn()

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('gmgn web multi — ledger quality', () => {
  beforeEach(() => {
    __resetGmgnWebMultiForTests()
    fetchMock.mockReset()
    process.env.GMGN_WEB_MAX_POST_PER_SEC = '1000'
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('multi_token_full_info')
        ? jsonRes({ code: 0, data: [sampleGmgnWebFullInfo(MINT)] })
        : jsonRes({ code: 0, data: [sampleGmgnWebWindow(MINT, 0)] }),
    )
  })
  afterEach(async () => {
    __resetGmgnWebMultiForTests()
    await __clearGmgnWebCacheForTests()
    vi.unstubAllGlobals()
    delete process.env.GMGN_WEB_MAX_POST_PER_SEC
  })

  it('a ledger write bypasses the 90s positive cache (no frozen partial panel)', async () => {
    await fetchGmgnWebMultiTokenInfo([MINT]) // warm the mint-only cache
    const warmCalls = fetchMock.mock.calls.length
    await fetchGmgnWebMultiTokenInfo([MINT]) // normal reader: served from cache
    expect(fetchMock.mock.calls.length).toBe(warmCalls)
    expect(getGmgnWebMultiMetrics().cacheHits).toBe(1)

    await fetchGmgnWebMultiTokenInfo([MINT], { ledgerWriteOnce: true })
    expect(fetchMock.mock.calls.length).toBeGreaterThan(warmCalls)
    expect(getGmgnWebMultiMetrics().cacheHits).toBe(1) // ledger read did not hit the cache
  })

  it('maps rat_trader_amount_rate from the row when the payload carries it', () => {
    const row = mapGmgnWebTokenRow({ ...sampleGmgnWebFullInfo(MINT), top_rat_trader_percentage: 0.04 })
    expect(row.security.rat_trader_amount_rate).toBe(0.04)
    expect(mapGmgnWebTokenRow(sampleGmgnWebFullInfo(MINT)).security.rat_trader_amount_rate).toBeNull()
  })
})
