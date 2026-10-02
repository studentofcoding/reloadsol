import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  connection: vi.fn(async () => undefined),
}))
vi.mock('@/utils/db', () => ({ query: vi.fn(), default: {} }))
vi.mock('@/utils/unified-logger', () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

const { hasTrendingTrackerSecret } = await import('@/utils/api-auth')
const copy = await import('@/app/api/metrics/copy/route')
const sample = await import('@/app/api/ohlc/sample/route')
const searchCycle = await import('@/app/api/strategies/search-cycle/route')

const SECRET = 's3cret-for-test'
const FALLBACK = 'r3l0ads0l-trending'

describe('TRENDING_TRACKER_SECRET auth has no committed fallback', () => {
  const prev = process.env.TRENDING_TRACKER_SECRET
  beforeEach(() => {
    process.env.TRENDING_TRACKER_SECRET = SECRET
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.TRENDING_TRACKER_SECRET
    else process.env.TRENDING_TRACKER_SECRET = prev
  })

  it('accepts the configured secret by key or bearer, rejects others', () => {
    const url = 'http://localhost/api/x'
    expect(hasTrendingTrackerSecret(new NextRequest(`${url}?key=${SECRET}`))).toBe(true)
    expect(
      hasTrendingTrackerSecret(
        new NextRequest(url, { headers: { authorization: `Bearer ${SECRET}` } }),
      ),
    ).toBe(true)
    expect(hasTrendingTrackerSecret(new NextRequest(`${url}?key=wrong`))).toBe(false)
    expect(hasTrendingTrackerSecret(new NextRequest(url))).toBe(false)
  })

  it('rejects the old fallback secret on all three routes when the env is unset', async () => {
    delete process.env.TRENDING_TRACKER_SECRET
    const mk = (path: string, method: string) =>
      new NextRequest(`http://localhost${path}?key=${FALLBACK}`, {
        method,
        headers: { authorization: `Bearer ${FALLBACK}` },
      })
    expect((await copy.POST(mk('/api/metrics/copy', 'POST'))).status).toBe(401)
    expect((await sample.POST(mk('/api/ohlc/sample', 'POST'))).status).toBe(401)
    expect((await searchCycle.POST(mk('/api/strategies/search-cycle', 'POST'))).status).toBe(401)
  })

  it('rejects a wrong key on all three routes when the env is set', async () => {
    const mk = (path: string, method: string) =>
      new NextRequest(`http://localhost${path}?key=${FALLBACK}`, { method })
    expect((await copy.POST(mk('/api/metrics/copy', 'POST'))).status).toBe(401)
    expect((await sample.POST(mk('/api/ohlc/sample', 'POST'))).status).toBe(401)
    expect((await searchCycle.POST(mk('/api/strategies/search-cycle', 'POST'))).status).toBe(401)
  })
})
