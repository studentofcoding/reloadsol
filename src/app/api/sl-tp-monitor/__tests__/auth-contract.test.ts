import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  connection: vi.fn(async () => undefined),
}))

const tracker = vi.hoisted(() => ({
  addSLTPPosition: vi.fn(async () => 'id-1'),
  cleanupOldSLTPPositions: vi.fn(async () => undefined),
  syncExistingOpenPositions: vi.fn(async () => ({ synced: 0, skipped: 0, errors: 0 })),
  runSLTPMonitorAndSummarize: vi.fn(),
  getSLTPTrackingSummary: vi.fn(async () => ({ statistics: {} })),
}))
vi.mock('@/utils/sl-tp-tracker', () => tracker)
vi.mock('@/utils/unified-logger', () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }))
vi.mock('@/utils/bot-job-lock', () => ({
  acquireJobLock: vi.fn(async () => ({ acquired: false, reason: 'held' })),
  releaseJobLock: vi.fn(),
}))

const { GET, POST, DELETE } = await import('../route')
const URL_BASE = 'http://localhost/api/sl-tp-monitor'
const SECRET = 's3cret-for-test'

describe('sl-tp-monitor auth', () => {
  const prev = process.env.TRENDING_TRACKER_SECRET
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.TRENDING_TRACKER_SECRET = SECRET
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.TRENDING_TRACKER_SECRET
    else process.env.TRENDING_TRACKER_SECRET = prev
  })

  it('rejects an unauthenticated POST before it can register a position', async () => {
    const res = await POST(new NextRequest(URL_BASE, { method: 'POST', body: '{}' }))
    expect(res.status).toBe(401)
    expect(tracker.addSLTPPosition).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated DELETE before it can purge history', async () => {
    const res = await DELETE(new NextRequest(`${URL_BASE}?days=0`, { method: 'DELETE' }))
    expect(res.status).toBe(401)
    expect(tracker.cleanupOldSLTPPositions).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated sync and summary reads', async () => {
    const sync = await GET(new NextRequest(`${URL_BASE}?action=sync&wallet=w`))
    const summary = await GET(new NextRequest(`${URL_BASE}?mode=summary`))
    expect(sync.status).toBe(401)
    expect(summary.status).toBe(401)
    expect(tracker.syncExistingOpenPositions).not.toHaveBeenCalled()
  })

  it('fails closed when the secret is unset — the old committed fallback must not work', async () => {
    delete process.env.TRENDING_TRACKER_SECRET
    const res = await GET(
      new NextRequest(URL_BASE, { headers: { authorization: 'Bearer r3l0ads0l-trending' } }),
    )
    expect(res.status).toBe(401)
  })

  it('accepts the bearer secret and clamps a hostile ?days=', async () => {
    const res = await DELETE(
      new NextRequest(`${URL_BASE}?days=-5`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    )
    expect(res.status).toBe(200)
    expect(tracker.cleanupOldSLTPPositions).toHaveBeenCalledWith(1)
  })
})
