import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('next/server')>()
  return { ...original, connection: vi.fn(async () => {}) }
})

import { GET } from '@/app/api/regime/climate/route'
import { resetClimateCache } from '@/utils/climateGate'

afterEach(() => {
  resetClimateCache()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function climateJson(overrides: Record<string, unknown> = {}) {
  return {
    h: 0.4,
    c: 0.9,
    state: 'Range',
    cascade: { veto: false },
    missing: ['e5', 'e4_depth'],
    pyth: { configured: true },
    timestamps: { computedAt: Date.now() },
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('GET /api/regime/climate', () => {
  it('returns a Safe chip payload from interpretClimate Range', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(climateJson({ state: 'Range' }))),
    )
    const response = await GET()
    const body = await response.json()
    expect(body.label).toBe('Safe')
    expect(body.ok).toBe(true)
    expect(body.stale).toBe(false)
    expect(body.state).toBe('Range')
    expect(body.headline).toBeNull()
    expect(response.headers.get('cache-control')).toBe(
      'no-store, max-age=0, must-revalidate',
    )
  })

  it('returns terminal headline/detail on the chip payload without changing Safe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          climateJson({
            state: 'Range',
            headline: 'Chop mode',
            detail: "Range-bound — don't chase.",
            tone: 'neutral',
          }),
        ),
      ),
    )
    const body = await (await GET()).json()
    expect(body.label).toBe('Safe')
    expect(body.headline).toBe('Chop mode')
    expect(body.detail).toBe("Range-bound — don't chase.")
    expect(body.tone).toBe('neutral')
    expect(body.state).toBe('Range')
  })

  it('returns Unknown on upstream fetch fail (fail-open scale is not Safe)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'nope' }, 503)),
    )
    const response = await GET()
    const body = await response.json()
    expect(body.ok).toBe(false)
    expect(body.label).toBe('Unknown')
    expect(body.scale).toBe(1)
  })

  it('returns Not safe for Cash and cascade veto', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(climateJson({ state: 'Cash' }))),
    )
    const cash = await (await GET()).json()
    expect(cash.label).toBe('Not safe')
    expect(cash.state).toBe('Cash')

    resetClimateCache()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(climateJson({ state: 'Hype', cascade: { veto: true } })),
      ),
    )
    const cascade = await (await GET()).json()
    expect(cascade.label).toBe('Not safe')
    expect(cascade.cascadeVeto).toBe(true)
  })
})
