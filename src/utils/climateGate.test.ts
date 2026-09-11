import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyClimateToNewRisk,
  fetchClimate,
  interpretClimate,
  resetClimateCache,
  sizeHint,
} from '@/utils/climateGate'

afterEach(() => {
  resetClimateCache()
  vi.unstubAllEnvs()
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
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('interpretClimate / sizeHint', () => {
  it('maps Cash=0 … Hype=1', () => {
    expect(sizeHint(interpretClimate(climateJson({ state: 'Cash' })))).toBe(0)
    expect(sizeHint(interpretClimate(climateJson({ state: 'De-risk' })))).toBe(0.25)
    expect(sizeHint(interpretClimate(climateJson({ state: 'Mixed' })))).toBe(0.5)
    expect(sizeHint(interpretClimate(climateJson({ state: 'Range' })))).toBe(0.75)
    expect(sizeHint(interpretClimate(climateJson({ state: 'Hype' })))).toBe(1)
  })

  it('caps cascade and news veto at ≤ trim even from Hype', () => {
    const cascade = interpretClimate(
      climateJson({ state: 'Hype', cascade: { veto: true } }),
    )
    expect(cascade.state).toBe('De-risk')
    expect(cascade.sizeKind).toBe('trim')
    expect(cascade.scale).toBe(0.25)
    expect(cascade.cascadeVeto).toBe(true)
    expect(cascade.reason).toContain('cascade.veto caps ≤ trim')

    const news = interpretClimate(
      climateJson({ state: 'Hype', cascade: { veto: false }, news: { shock: true } }),
    )
    expect(news.sizeKind).toBe('trim')
    expect(news.newsShock).toBe(true)
    expect(news.scale).toBe(0.25)
  })

  it('treats expected missing e5/e4_depth as notWired, not feed alarms', () => {
    const parsed = interpretClimate(climateJson({ missing: ['e5', 'e4_depth', 'binance'] }))
    expect(parsed.notWired).toEqual(['e5', 'e4_depth'])
    expect(parsed.feedAlarms).toEqual(['binance'])
  })

  it('rejects malformed payloads', () => {
    expect(() => interpretClimate(null)).toThrow(/not object/)
    expect(() => interpretClimate({ h: 1, c: 1, state: 'Moon' })).toThrow(/missing h\/c\/state/)
  })
})

describe('fetchClimate', () => {
  it('caches for ~30s', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(climateJson({ state: 'Range' })))
    const first = await fetchClimate({ fetchImpl, now: 1_000 })
    const second = await fetchClimate({ fetchImpl, now: 20_000 })
    expect(first.scale).toBe(0.75)
    expect(second).toBe(first)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('fail-opens on fetch error unless fail-closed', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'nope' }, 503))
    const open = await fetchClimate({ fetchImpl, failClosed: false, now: 1 })
    expect(open.ok).toBe(false)
    expect(open.scale).toBe(1)
    expect(open.reason).toContain('fail-open')

    resetClimateCache()
    const closed = await fetchClimate({ fetchImpl, failClosed: true, now: 1 })
    expect(closed.scale).toBe(0)
    expect(closed.reason).toContain('fail-closed')
  })
})

describe('applyClimateToNewRisk', () => {
  it('is a no-op when CLIMATE_GATE is off (default)', async () => {
    vi.stubEnv('CLIMATE_GATE', '')
    const fetchImpl = vi.fn(async () => jsonResponse(climateJson()))
    const decision = await applyClimateToNewRisk({
      amount: 1,
      paper: true,
      source: 'test',
      fetchImpl,
    })
    expect(decision.applied).toBe(false)
    expect(decision.allowed).toBe(true)
    expect(decision.amount).toBe(1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not force live size without CLIMATE_GATE_LIVE', async () => {
    vi.stubEnv('CLIMATE_GATE', '1')
    vi.stubEnv('CLIMATE_GATE_LIVE', '')
    const fetchImpl = vi.fn(async () => jsonResponse(climateJson({ state: 'Cash' })))
    const decision = await applyClimateToNewRisk({
      amount: 2,
      paper: false,
      source: 'dlmm_deploy',
      fetchImpl,
    })
    expect(decision.applied).toBe(false)
    expect(decision.allowed).toBe(true)
    expect(decision.amount).toBe(2)
    expect(decision.reason).toMatch(/ask/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('blocks stand-down and cascade on paper when enabled', async () => {
    vi.stubEnv('CLIMATE_GATE', '1')
    const cash = await applyClimateToNewRisk({
      amount: 1,
      paper: true,
      source: 'dlmm_deploy',
      fetchImpl: async () => jsonResponse(climateJson({ state: 'Cash' })),
    })
    expect(cash.allowed).toBe(false)
    expect(cash.reason).toContain('climate_stand_down')

    resetClimateCache()
    const cascade = await applyClimateToNewRisk({
      amount: 1,
      paper: true,
      source: 'dlmm_deploy',
      fetchImpl: async () =>
        jsonResponse(climateJson({ state: 'Hype', cascade: { veto: true } })),
    })
    expect(cascade.allowed).toBe(false)
    expect(cascade.reason).toContain('climate_cascade')
    expect(cascade.scale).toBe(0.25)
  })

  it('scales size by sizeHint otherwise and never exceeds the requested amount', async () => {
    vi.stubEnv('CLIMATE_GATE', '1')
    const decision = await applyClimateToNewRisk({
      amount: 2,
      paper: true,
      source: 'dlmm_sim_track',
      fetchImpl: async () => jsonResponse(climateJson({ state: 'Range' })),
    })
    expect(decision.allowed).toBe(true)
    expect(decision.applied).toBe(true)
    expect(decision.scale).toBe(0.75)
    expect(decision.amount).toBe(1.5)
  })

  it('applies on live only when CLIMATE_GATE_LIVE=1', async () => {
    vi.stubEnv('CLIMATE_GATE', '1')
    vi.stubEnv('CLIMATE_GATE_LIVE', '1')
    const decision = await applyClimateToNewRisk({
      amount: 2,
      paper: false,
      source: 'dlmm_deploy',
      fetchImpl: async () => jsonResponse(climateJson({ state: 'Range' })),
    })
    expect(decision.applied).toBe(true)
    expect(decision.amount).toBe(1.5)
  })
})
