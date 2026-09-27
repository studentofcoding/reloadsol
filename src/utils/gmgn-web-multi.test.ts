import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { evaluateConcentrationBan } from '@/strategies/concentration-ban'
import { buildGmgnTokenSnapshot } from '@/strategies/gmgn-token-snapshot'
import {
  sampleGmgnWebFullInfo,
  sampleGmgnWebHolderStat,
  sampleGmgnWebWindow,
} from '@/utils/gmgn-web-multi.fixtures'
import {
  __clearGmgnWebCacheForTests,
  __resetGmgnWebMultiForTests,
  chunkGmgnWebAddresses,
  enqueueGmgnWebLedgerMint,
  enqueueGmgnWebLedgerMints,
  fetchGmgnWebMultiTokenInfo,
  getGmgnWebMultiMetrics,
  gmgnTokenInfoSource,
  gmgnWebMaxBatch,
  gmgnWebMinIntervalMs,
  GMGN_WEB_MULTI_HARD_MAX_BATCH,
  mapGmgnWebTokenRow,
  markGmgnWebLedgerCaptured,
  normalizeGmgnWebMints,
  usesGmgnWebTokenInfo,
} from '@/utils/gmgn-web-multi'

const MINT_A = 'So11111111111111111111111111111111111111112'
const MINT_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const MINT_C = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'

const fetchMock = vi.fn()

function mintAt(index: number): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  const mark = alphabet[index % alphabet.length]!
  return (`GmgnWeb${mark}` + '1'.repeat(40)).slice(0, 40)
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function postBatches(pathPart: string): string[][] {
  return fetchMock.mock.calls
    .filter((call) => {
      const init = call[1] as RequestInit | undefined
      return String(call[0]).includes(pathPart) && init?.method === 'POST'
    })
    .map((call) => {
      const init = call[1] as RequestInit
      const body = JSON.parse(String(init.body)) as { addresses: string[] }
      return body.addresses
    })
}

describe('gmgn web multi pure helpers', () => {
  afterEach(() => {
    delete process.env.GMGN_WEB_MULTI_MAX_BATCH
    delete process.env.GMGN_WEB_MAX_POST_PER_SEC
    delete process.env.GMGN_TOKEN_INFO_SOURCE
  })

  it('chunks 9 addresses into 8 + 1', () => {
    const chunks = chunkGmgnWebAddresses([1, 2, 3, 4, 5, 6, 7, 8, 9], 8)
    expect(chunks).toEqual([
      [1, 2, 3, 4, 5, 6, 7, 8],
      [9],
    ])
  })

  it('clamps the batch size at 8', () => {
    process.env.GMGN_WEB_MULTI_MAX_BATCH = '11'
    expect(gmgnWebMaxBatch()).toBe(GMGN_WEB_MULTI_HARD_MAX_BATCH)
    expect(chunkGmgnWebAddresses([1, 2, 3, 4, 5, 6, 7, 8, 9]).map((c) => c.length)).toEqual([
      8, 1,
    ])
    process.env.GMGN_WEB_MULTI_MAX_BATCH = '3'
    expect(gmgnWebMaxBatch()).toBe(3)
  })

  it('dedupes and drops non-mints', () => {
    expect(normalizeGmgnWebMints([MINT_A, `  ${MINT_A}  `, 'nope', MINT_B, MINT_A])).toEqual([
      MINT_A,
      MINT_B,
    ])
  })

  it('defaults to openapi and 0.4 posts/sec', () => {
    delete process.env.GMGN_WEB_MAX_POST_PER_SEC
    expect(gmgnWebMinIntervalMs()).toBe(2500)
    expect(gmgnTokenInfoSource()).toBe('openapi')
    expect(usesGmgnWebTokenInfo('sol')).toBe(false)
    process.env.GMGN_TOKEN_INFO_SOURCE = 'web'
    expect(usesGmgnWebTokenInfo('sol')).toBe(true)
    expect(usesGmgnWebTokenInfo('robinhood')).toBe(false)
  })

  it('maps full_info + window + holder stat onto the nine Freeview tiles', () => {
    const boostTs = Date.now() / 1000 - 5 * 3600
    const row = mapGmgnWebTokenRow(
      sampleGmgnWebFullInfo(MINT_A),
      sampleGmgnWebWindow(MINT_A, boostTs),
      sampleGmgnWebHolderStat,
    )
    const snap = buildGmgnTokenSnapshot(row.info, row.security)
    expect(snap.top10HoldPct).toBeCloseTo(13.15, 1)
    expect(snap.devHoldPct).toBeCloseTo(2, 1)
    expect(snap.snipersHoldPct).toBeCloseTo(5, 1)
    expect(snap.sniperWalletCount).toBe(7)
    expect(snap.freezeAuthActive).toBe(true)
    expect(snap.mintAuthActive).toBe(false)
    expect(snap.proTradersPct).toBeCloseTo(11, 1)
    expect(snap.insidersHoldPct).toBeCloseTo(4, 1)
    expect(snap.bundlersHoldPct).toBeCloseTo(0.63, 1)
    expect(snap.dexBoostLabel).toMatch(/^Boost/)
    expect(row.security.burn_status).toBe('burn')
    expect(row.security.insider_count).toBe(3)
    expect(row.security.bundler_count).toBe(4)
    expect(row.info.price).toEqual({ price: '0.00012', price_1m: '0.0001' })
  })

  it('still bans live concentration above 65% from a web-mapped row', () => {
    const row = mapGmgnWebTokenRow({
      address: MINT_A,
      stat: { top_10_holder_rate: 0.8, creator_hold_rate: 0, top_bundler_trader_percentage: 0 },
      security: { renounced_mint: true, renounced_freeze_account: true },
    })
    const snap = buildGmgnTokenSnapshot(row.info, row.security)
    expect(evaluateConcentrationBan(snap).ban).toBe(true)
    expect(snap.top10HoldPct).toBeCloseTo(80, 1)
  })
})

describe('fetchGmgnWebMultiTokenInfo', () => {
  beforeEach(() => {
    __resetGmgnWebMultiForTests()
    fetchMock.mockReset()
    process.env.GMGN_WEB_MAX_POST_PER_SEC = '1000'
    process.env.GMGN_WEB_LEDGER_DEBOUNCE_MS = '200'
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockImplementation(() => jsonRes({ code: 0, data: [] }))
  })

  afterEach(async () => {
    __resetGmgnWebMultiForTests()
    await __clearGmgnWebCacheForTests()
    vi.unstubAllGlobals()
    delete process.env.GMGN_WEB_MAX_POST_PER_SEC
    delete process.env.GMGN_WEB_LEDGER_DEBOUNCE_MS
    delete process.env.GMGN_WEB_HOST
    delete process.env.GMGN_TOKEN_INFO_SOURCE
  })

  it('sends 9 mints as batches of 8 and 1', async () => {
    const mints = Array.from({ length: 9 }, (_, i) => mintAt(i))
    await fetchGmgnWebMultiTokenInfo(mints)
    expect(postBatches('multi_token_full_info').map((batch) => batch.length)).toEqual([8, 1])
    expect(postBatches('mutil_window_token_info').map((batch) => batch.length)).toEqual([8, 1])
    expect(getGmgnWebMultiMetrics().upstreamCalls).toBe(4)
    expect(getGmgnWebMultiMetrics().lastBatchSize).toBe(1)
  })

  it('dedupes before the upstream POST', async () => {
    await fetchGmgnWebMultiTokenInfo([MINT_A, MINT_A, 'not-a-mint', ` ${MINT_A} `])
    expect(postBatches('multi_token_full_info')).toEqual([[MINT_A]])
  })

  it('does not call upstream when every address is invalid', async () => {
    const rows = await fetchGmgnWebMultiTokenInfo(['abc', '0OIl'])
    expect(rows).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses minimal browser headers and no cookie', async () => {
    await fetchGmgnWebMultiTokenInfo([MINT_A])
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers.Accept).toBe('application/json')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers.Origin).toBe('https://gmgn.ai')
    expect(headers.Referer).toBe('https://gmgn.ai/')
    expect(headers.Cookie).toBeUndefined()
    expect(headers['User-Agent']).toBeUndefined()
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/mrwapi/v1/multi_token_full_info')
  })

  it('coalesces an overlapping in-flight set onto one call per mint', async () => {
    let release!: () => void
    const block = new Promise<void>((resolve) => {
      release = resolve
    })
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('multi_token_full_info')) await block
      return jsonRes({ code: 0, data: [] })
    })

    const first = fetchGmgnWebMultiTokenInfo([MINT_A, MINT_B])
    const second = fetchGmgnWebMultiTokenInfo([MINT_B, MINT_C])
    await vi.waitFor(() => {
      expect(postBatches('multi_token_full_info')).toHaveLength(2)
    })
    const batches = postBatches('multi_token_full_info').map((batch) => [...batch].sort())
    expect(batches).toContainEqual([MINT_A, MINT_B].sort())
    expect(batches).toContainEqual([MINT_C])
    release()
    await Promise.all([first, second])
    expect(getGmgnWebMultiMetrics().coalesced).toBe(1)
  })

  it('serves a second read from the positive cache', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('multi_token_full_info')) {
        return jsonRes({ code: 0, data: [sampleGmgnWebFullInfo(MINT_A)] })
      }
      return jsonRes({ code: 0, data: [sampleGmgnWebWindow(MINT_A, 0)] })
    })
    const first = await fetchGmgnWebMultiTokenInfo([MINT_A])
    const callsAfterFirst = fetchMock.mock.calls.length
    const second = await fetchGmgnWebMultiTokenInfo([MINT_A])
    expect(first[0]?.info.symbol).toBe('TILE')
    expect(second[0]?.security.top_10_holder_rate).toBe(0.1315)
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst)
    expect(getGmgnWebMultiMetrics().cacheHits).toBe(1)
  })

  it('cools down after 429 and does not retry', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ code: 429, msg: 'rate' }, 429))
    await expect(fetchGmgnWebMultiTokenInfo([MINT_A])).rejects.toMatchObject({ code: 'RATE_LIMIT' })
    await expect(fetchGmgnWebMultiTokenInfo([MINT_B])).rejects.toMatchObject({ code: 'RATE_LIMIT' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getGmgnWebMultiMetrics().http429).toBe(1)
    expect(getGmgnWebMultiMetrics().negativeSkips).toBeGreaterThanOrEqual(1)
  })

  it('cools down on a Cloudflare 403 challenge', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html>Attention Required! | Cloudflare</html>', {
        status: 403,
        headers: { 'Content-Type': 'text/html' },
      }),
    )
    await expect(fetchGmgnWebMultiTokenInfo([MINT_A])).rejects.toMatchObject({ code: 'BLOCKED' })
    await expect(fetchGmgnWebMultiTokenInfo([MINT_A])).rejects.toMatchObject({ code: 'BLOCKED' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getGmgnWebMultiMetrics().http403).toBe(1)
  })

  it('does not cooldown a 400 invalid argument', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ message: 'invalid argument' }, 400))
    await expect(fetchGmgnWebMultiTokenInfo([MINT_A])).rejects.toMatchObject({ code: 'INVALID' })
    await fetchGmgnWebMultiTokenInfo([MINT_B])
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
  })

  it('retries a 5xx once', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ msg: 'unavailable' }, 500))
      .mockResolvedValueOnce(jsonRes({ code: 0, data: [sampleGmgnWebFullInfo(MINT_A)] }))
      .mockResolvedValue(jsonRes({ code: 0, data: [] }))
    const rows = await fetchGmgnWebMultiTokenInfo([MINT_A])
    expect(rows).toHaveLength(1)
    expect(postBatches('multi_token_full_info')).toHaveLength(2)
  })

  it('GETs holder stat only when the sniper count is missing', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const href = String(url)
      if (href.includes('multi_token_full_info')) {
        return jsonRes({ code: 0, data: [sampleGmgnWebFullInfo(MINT_A)] })
      }
      if (href.includes('token_holder_stat')) {
        return jsonRes({ code: 0, data: sampleGmgnWebHolderStat })
      }
      return jsonRes({ code: 0, data: [] })
    })
    const missing = await fetchGmgnWebMultiTokenInfo([MINT_A], { includeHolderStat: 'if-missing' })
    expect(missing[0]?.security.sniper_count).toBe(7)
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('token_holder_stat'))).toBe(
      true,
    )

    __resetGmgnWebMultiForTests()
    await __clearGmgnWebCacheForTests()
    fetchMock.mockClear()
    fetchMock.mockImplementation(async (url: string) => {
      const href = String(url)
      if (href.includes('multi_token_full_info')) {
        return jsonRes({
          code: 0,
          data: [{ ...sampleGmgnWebFullInfo(MINT_B), sniper_count: 4 }],
        })
      }
      return jsonRes({ code: 0, data: [] })
    })
    const present = await fetchGmgnWebMultiTokenInfo([MINT_B], { includeHolderStat: 'if-missing' })
    expect(present[0]?.security.sniper_count).toBe(4)
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('token_holder_stat'))).toBe(
      false,
    )
  })

  it('flushes the ledger queue in batches of 8', async () => {
    const mints = Array.from({ length: 9 }, (_, i) => mintAt(i + 10))
    await enqueueGmgnWebLedgerMints(mints)
    expect(postBatches('multi_token_full_info').map((batch) => batch.length)).toEqual([8, 1])
  })

  it('collapses duplicate ledger mints into one batch', async () => {
    await Promise.all([
      enqueueGmgnWebLedgerMint(MINT_A),
      enqueueGmgnWebLedgerMint(MINT_A),
      enqueueGmgnWebLedgerMint(MINT_B),
    ])
    expect(postBatches('multi_token_full_info')).toEqual([[MINT_A, MINT_B]])
  })

  it('skips a ledger refetch once the mint is marked captured', async () => {
    await markGmgnWebLedgerCaptured(MINT_A)
    const rows = await enqueueGmgnWebLedgerMint(MINT_A)
    expect(rows).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(getGmgnWebMultiMetrics().ledgerSkips).toBe(1)
  })
})
