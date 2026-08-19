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
})
