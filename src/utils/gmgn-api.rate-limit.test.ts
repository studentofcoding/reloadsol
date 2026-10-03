import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { GmgnApiError } from './gmgn-api'

let server: Server
let requestCount = 0
let responses: Array<{ status: number; body: string; headers?: Record<string, string> }> = []

beforeEach(async () => {
  requestCount = 0
  responses = []
  process.env.GMGN_API_KEY = 'test-key'
  process.env.GMGN_MAX_REQ_PER_SEC = '100'
  server = createServer((req, res) => {
    requestCount++
    const r = responses.shift() ?? { status: 200, body: JSON.stringify({ code: 0, data: {} }) }
    if (r.headers) {
      for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v)
    }
    res.writeHead(r.status, { 'Content-Type': 'application/json' })
    res.end(r.body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  process.env.GMGN_API_HOST = `http://127.0.0.1:${addr.port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  delete process.env.GMGN_API_HOST
  delete process.env.GMGN_API_KEY
  delete process.env.GMGN_MAX_REQ_PER_SEC
  // Reset the module-level negative rate-limit cache so tests are isolated.
  const { __resetRateLimitCooldownForTests } = await import('./gmgn-api')
  __resetRateLimitCooldownForTests()
})

describe('gmgn-api rate limiting + gate (public API)', () => {
  it('default gap is 715ms (1.4 rps) when env unset', async () => {
    delete process.env.GMGN_MAX_REQ_PER_SEC
    const { gmgnMinIntervalMs } = await import('./gmgn-api')
    // Calibrated to the measured ceiling (~3.6 rps, 429 at the 6th back-to-back
    // call) at ~40% — see docs/GMGN_RATE_BUDGET.md.
    expect(gmgnMinIntervalMs()).toBe(715)
  })

  it('tokenInfo unwraps a normal response', async () => {
    const { tokenInfo } = await import('./gmgn-api')
    responses = [{ status: 200, body: JSON.stringify({ code: 0, data: { symbol: 'HOOD' } }) }]
    const info = await tokenInfo({ chain: 'robinhood', address: '0xabc' })
    expect(info.symbol).toBe('HOOD')
    expect(requestCount).toBe(1)
  })

  it('serializes concurrent tokenInfo calls through the gate', async () => {
    const { tokenInfo } = await import('./gmgn-api')
    process.env.GMGN_MAX_REQ_PER_SEC = '20' // 50ms min gap → clear serialization signal
    const start = Date.now()
    responses = [
      { status: 200, body: JSON.stringify({ code: 0, data: { symbol: 'A' } }) },
      { status: 200, body: JSON.stringify({ code: 0, data: { symbol: 'B' } }) },
    ]
    await Promise.all([
      tokenInfo({ chain: 'sol', address: 'aaa' }),
      tokenInfo({ chain: 'sol', address: 'bbb' }),
    ])
    const elapsed = Date.now() - start
    expect(requestCount).toBe(2)
    // Serialized: the second call waits for the first's gap (~50ms) before
    // starting, so total ≈ one gap + request time. Parallel would be ~0ms.
    expect(elapsed).toBeGreaterThanOrEqual(40)
  })

  it('throws RATE_LIMIT and cooldowns subsequent calls (no upstream hit)', async () => {
    const { tokenInfo, GmgnApiError } = await import('./gmgn-api')
    // Reset far out (> MAX_RETRY_WAIT_MS) → fail fast instead of sleeping.
    const resetAt = Math.floor(Date.now() / 1000) + 30
    responses = [
      { status: 429, body: JSON.stringify({ code: 429, msg: 'rate limited', data: null }), headers: { 'X-RateLimit-Reset': String(resetAt) } },
    ]
    const err = await tokenInfo({ chain: 'sol', address: 'aaa' }).catch((e) => e) as GmgnApiError
    expect(err).toBeInstanceOf(GmgnApiError)
    expect(err.code).toBe('RATE_LIMIT')
    // Subsequent call fails fast from the negative cache — no upstream request.
    const err2 = await tokenInfo({ chain: 'sol', address: 'bbb' }).catch((e) => e) as GmgnApiError
    expect(err2.code).toBe('RATE_LIMIT')
    expect(requestCount).toBe(1)
  })

  it('retries once when the reset is near', async () => {
    const { tokenInfo, unwrapApiData } = await import('./gmgn-api')
    const resetAt = Math.floor(Date.now() / 1000) + 1
    responses = [
      { status: 429, body: JSON.stringify({ code: 429, msg: 'rl', data: null }), headers: { 'X-RateLimit-Reset': String(resetAt) } },
      { status: 200, body: JSON.stringify({ code: 0, data: { symbol: 'HOOD' } }) },
    ]
    const info = await tokenInfo({ chain: 'sol', address: 'aaa' })
    expect(info.symbol).toBe('HOOD')
    expect(requestCount).toBe(2)
  })

  it('propagates upstream non-429 errors', async () => {
    const { tokenInfo, GmgnApiError } = await import('./gmgn-api')
    responses = [{ status: 500, body: JSON.stringify({ code: 50000, msg: 'chain not supported' }) }]
    const err = await tokenInfo({ chain: 'robinhood', address: '0xabc' }).catch((e) => e) as GmgnApiError
    expect(err).toBeInstanceOf(GmgnApiError)
    expect(err.message).toMatch(/chain not supported/)
  })

  it('keeps the cooldown per endpoint: a 429 on one path does not fail-fast another', async () => {
    const { tokenInfo, trackSmartMoney, GmgnApiError, __isPathCoolingForTests } = await import('./gmgn-api')
    const resetAt = Math.floor(Date.now() / 1000) + 30
    responses = [
      { status: 429, body: JSON.stringify({ code: 429, msg: 'rl', data: null }), headers: { 'X-RateLimit-Reset': String(resetAt) } },
    ]
    const err = (await trackSmartMoney({ chain: 'sol' }).catch((e) => e)) as GmgnApiError
    expect(err).toBeInstanceOf(GmgnApiError)
    expect(__isPathCoolingForTests('/v1/user/smartmoney')).toBe(true)
    expect(__isPathCoolingForTests('/v1/token/info')).toBe(false)

    // A different endpoint still reaches upstream.
    responses = [{ status: 200, body: JSON.stringify({ code: 0, data: { symbol: 'OK' } }) }]
    const info = await tokenInfo({ chain: 'sol', address: 'aaa' })
    expect(info.symbol).toBe('OK')
    expect(requestCount).toBe(2)

    // The same endpoint is still cooling (no upstream hit).
    const err2 = (await trackSmartMoney({ chain: 'sol' }).catch((e) => e)) as GmgnApiError
    expect(err2.code).toBe('RATE_LIMIT')
    expect(requestCount).toBe(2)
  })

  it('honors Retry-After (delta seconds) and widens the gate after a 429', async () => {
    const { tokenInfo, gmgnEffectiveMinIntervalMs, gmgnMinIntervalMs } = await import('./gmgn-api')
    expect(gmgnEffectiveMinIntervalMs()).toBe(gmgnMinIntervalMs())
    // Retry-After 1s is within the retry window -> sleeps, retries, succeeds.
    responses = [
      { status: 429, body: JSON.stringify({ code: 429, msg: 'rl', data: null }), headers: { 'Retry-After': '1' } },
      { status: 200, body: JSON.stringify({ code: 0, data: { symbol: 'RA' } }) },
    ]
    const info = await tokenInfo({ chain: 'sol', address: 'aaa' })
    expect(info.symbol).toBe('RA')
    expect(requestCount).toBe(2)
    // Retry succeeded -> no cooldown armed, so no pacing penalty either.
    expect(gmgnEffectiveMinIntervalMs()).toBe(gmgnMinIntervalMs())

    // A Retry-After beyond the retry window fails fast, arms the cooldown, and slows the gate.
    responses = [{ status: 429, body: '{}', headers: { 'Retry-After': '20' } }]
    const err = await tokenInfo({ chain: 'sol', address: 'bbb' }).catch((e) => e)
    expect(err.code).toBe('RATE_LIMIT')
    expect(gmgnEffectiveMinIntervalMs()).toBe(gmgnMinIntervalMs() * 2)
  })
})

describe('computeRateLimitCooldownMs / parseRetryAfter', () => {
  it('backs off exponentially without a hint (5s, 10s, 20s, capped 30s), no jitter at random=0', async () => {
    const { computeRateLimitCooldownMs } = await import('./gmgn-api')
    const f = (strikes: number) => computeRateLimitCooldownMs({ strikes, random: 0 })
    expect([f(1), f(2), f(3), f(4), f(9)]).toEqual([5000, 10000, 20000, 30000, 30000])
  })

  it('adds up to 25% jitter but never exceeds the 30s cap', async () => {
    const { computeRateLimitCooldownMs } = await import('./gmgn-api')
    expect(computeRateLimitCooldownMs({ strikes: 1, random: 0.999 })).toBeLessThanOrEqual(6250)
    expect(computeRateLimitCooldownMs({ strikes: 1, random: 0.999 })).toBeGreaterThan(5000)
    expect(computeRateLimitCooldownMs({ strikes: 6, random: 0.999 })).toBe(30000)
  })

  it('honors a reset hint (clamped to 1s..30s) over the ladder', async () => {
    const { computeRateLimitCooldownMs } = await import('./gmgn-api')
    const nowMs = 1_000_000_000_000
    const at = (secsAhead: number) => nowMs / 1000 + secsAhead
    expect(computeRateLimitCooldownMs({ strikes: 5, resetAt: at(8), nowMs, random: 0 })).toBe(8000)
    expect(computeRateLimitCooldownMs({ strikes: 1, resetAt: at(-5), nowMs, random: 0 })).toBe(1000)
    expect(computeRateLimitCooldownMs({ strikes: 1, resetAt: at(300), nowMs, random: 0 })).toBe(30000)
  })

  it('parses Retry-After as delta-seconds or HTTP date, and ignores junk', async () => {
    const { parseRetryAfter } = await import('./gmgn-api')
    const nowMs = Date.parse('2026-10-03T00:00:00Z')
    expect(parseRetryAfter('7', nowMs)).toBeCloseTo(nowMs / 1000 + 7)
    expect(parseRetryAfter('Sat, 03 Oct 2026 00:00:12 GMT', nowMs)).toBeCloseTo(nowMs / 1000 + 12)
    expect(parseRetryAfter('', nowMs)).toBeUndefined()
    expect(parseRetryAfter(null, nowMs)).toBeUndefined()
    expect(parseRetryAfter('soon', nowMs)).toBeUndefined()
    expect(parseRetryAfter('-3', nowMs)).toBeUndefined()
  })
})
