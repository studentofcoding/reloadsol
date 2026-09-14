import { describe, expect, it } from 'vitest'
import {
  climateChipLabel,
  isClimateDisplayStale,
  toClimateChipPayload,
} from '@/utils/climateDisplay'
import { interpretClimate } from '@/utils/climateGate'

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

function fromInterpreted(
  data: unknown,
  extra: {
    ok?: boolean
    error?: string
    fetchedAt?: number
    computedAt?: number | null
    now?: number
    scale?: number
  } = {},
) {
  const parsed = interpretClimate(data)
  const fetchedAt = extra.fetchedAt ?? 1_000
  return toClimateChipPayload(
    {
      ok: extra.ok ?? true,
      error: extra.error,
      fetchedAt,
      computedAt: extra.computedAt ?? fetchedAt,
      state: parsed.state,
      h: parsed.h,
      cascadeVeto: parsed.cascadeVeto,
      sizeKind: parsed.sizeKind,
      scale: extra.scale ?? parsed.scale,
    },
    { now: extra.now ?? fetchedAt },
  )
}

describe('climateChipLabel / toClimateChipPayload', () => {
  it('maps Mixed, Range, and Hype to Safe when there is no cascade veto', () => {
    expect(fromInterpreted(climateJson({ state: 'Mixed' })).label).toBe('Safe')
    expect(fromInterpreted(climateJson({ state: 'Range' })).label).toBe('Safe')
    expect(fromInterpreted(climateJson({ state: 'Hype' })).label).toBe('Safe')
  })

  it('maps Cash and De-risk to Not safe', () => {
    expect(fromInterpreted(climateJson({ state: 'Cash' })).label).toBe('Not safe')
    expect(fromInterpreted(climateJson({ state: 'De-risk' })).label).toBe('Not safe')
  })

  it('maps cascade.veto to Not safe even when the raw state is Hype', () => {
    const payload = fromInterpreted(
      climateJson({ state: 'Hype', cascade: { veto: true } }),
    )
    expect(payload.cascadeVeto).toBe(true)
    expect(payload.state).toBe('De-risk')
    expect(payload.label).toBe('Not safe')
  })

  it('treats cascade veto as Not safe even if interpreted state stayed Mixed', () => {
    expect(
      climateChipLabel({
        ok: true,
        stale: false,
        cascadeVeto: true,
        state: 'Mixed',
      }),
    ).toBe('Not safe')
  })

  it('does not let e4_depth-only missing force Not safe', () => {
    const payload = fromInterpreted(
      climateJson({ state: 'Range', missing: ['e4_depth'] }),
    )
    expect(payload.label).toBe('Safe')
    expect(payload.state).toBe('Range')
  })

  it('maps fetch fail / error to Unknown even when fail-open scale is 1', () => {
    const payload = toClimateChipPayload(
      {
        ok: false,
        error: 'HTTP 503',
        fetchedAt: 1_000,
        computedAt: null,
        state: null,
        h: null,
        cascadeVeto: false,
        sizeKind: 'unknown',
        scale: 1,
      },
      { now: 1_000 },
    )
    expect(payload.label).toBe('Unknown')
    expect(payload.ok).toBe(false)
    expect(payload.scale).toBe(1)
    expect(payload.label).not.toBe('Safe')
  })

  it('maps ok=false without error (fail-open gate) to Unknown, not Safe/Hype', () => {
    expect(
      climateChipLabel({
        ok: false,
        stale: false,
        cascadeVeto: false,
        state: 'Hype',
      }),
    ).toBe('Unknown')
  })

  it('maps stale fetchedAt older than 90s to Unknown', () => {
    const payload = fromInterpreted(climateJson({ state: 'Hype' }), {
      fetchedAt: 1_000,
      computedAt: 1_000,
      now: 1_000 + 90_001,
    })
    expect(payload.stale).toBe(true)
    expect(payload.label).toBe('Unknown')
  })

  it('maps stale computedAt older than 90s to Unknown even if just fetched', () => {
    const payload = fromInterpreted(climateJson({ state: 'Range' }), {
      fetchedAt: 100_000,
      computedAt: 1_000,
      now: 100_000,
    })
    expect(payload.stale).toBe(true)
    expect(payload.label).toBe('Unknown')
    expect(payload.state).toBe('Range')
  })

  it('is not stale at exactly 90s', () => {
    expect(
      isClimateDisplayStale({
        now: 91_000,
        fetchedAt: 1_000,
        computedAt: 1_000,
      }),
    ).toBe(false)
    const payload = fromInterpreted(climateJson({ state: 'Mixed' }), {
      fetchedAt: 1_000,
      computedAt: 1_000,
      now: 91_000,
    })
    expect(payload.stale).toBe(false)
    expect(payload.label).toBe('Safe')
  })

  it('keeps binary label authoritative while still passing state and h through', () => {
    const payload = fromInterpreted(climateJson({ state: 'Hype', h: 0.88 }))
    expect(payload.label).toBe('Safe')
    expect(payload.state).toBe('Hype')
    expect(payload.h).toBe(0.88)
    expect(payload.sizeKind).toBe('full')
    expect(payload.scale).toBe(1)
  })
})
