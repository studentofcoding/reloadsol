import { describe, expect, it } from 'vitest'
import {
  climateChipLabel,
  formatClimateH,
  formatClimateRegimeDetail,
  formatClimateRegimeTooltip,
  isClimateChipSafe,
  isClimateDisplayStale,
  toClimateChipPayload,
} from '@/utils/climateDisplay'
import { interpretClimate, readClimateHumanCopy } from '@/utils/climateGate'

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
  const human = readClimateHumanCopy(data)
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
      headline: human.headline,
      detail: human.detail,
      tone: human.tone,
    },
    { now: extra.now ?? fetchedAt },
  )
}

describe('climateChipLabel / toClimateChipPayload', () => {
  it('isClimateChipSafe is true only for the Safe label', () => {
    expect(isClimateChipSafe('Safe')).toBe(true)
    expect(isClimateChipSafe('Not safe')).toBe(false)
    expect(isClimateChipSafe('Unknown')).toBe(false)
    expect(isClimateChipSafe(null)).toBe(false)
  })

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

  it('passes terminal headline/detail/tone through without changing Safe/Not safe', () => {
    const payload = fromInterpreted(
      climateJson({
        state: 'Range',
        headline: 'Chop mode',
        detail: "Range-bound — don't chase.",
        tone: 'neutral',
      }),
    )
    expect(payload.label).toBe('Safe')
    expect(payload.headline).toBe('Chop mode')
    expect(payload.detail).toBe("Range-bound — don't chase.")
    expect(payload.tone).toBe('neutral')

    const dumping = fromInterpreted(
      climateJson({
        state: 'Cash',
        headline: 'BTC is dumping — beware',
        detail: 'Stand down until the tape settles.',
        tone: 'danger',
      }),
    )
    expect(dumping.label).toBe('Not safe')
    expect(dumping.headline).toBe('BTC is dumping — beware')
    expect(dumping.tone).toBe('danger')
  })

  it('keeps Cash/De-risk/cascade/news as Not safe even when headline is present', () => {
    expect(
      fromInterpreted(
        climateJson({
          state: 'Hype',
          cascade: { veto: true },
          headline: 'Chop mode',
        }),
      ).label,
    ).toBe('Not safe')
    expect(
      fromInterpreted(
        climateJson({
          state: 'Hype',
          news: { shock: true },
          headline: 'Mixed tape',
        }),
      ).label,
    ).toBe('Not safe')
  })
})

describe('formatClimateH / formatClimateRegimeDetail', () => {
  it('rounds H to one decimal as H 0.5', () => {
    expect(formatClimateH(0.48)).toBe('H 0.5')
    expect(formatClimateH(0.5)).toBe('H 0.5')
    expect(formatClimateH(null)).toBeNull()
    expect(formatClimateH(Number.NaN)).toBeNull()
  })

  it('prefers terminal headline over state · H', () => {
    expect(
      formatClimateRegimeDetail({
        headline: 'Chop mode',
        state: 'Range',
        h: 0.52,
      }),
    ).toBe('Chop mode')
    expect(
      formatClimateRegimeDetail({
        headline: 'BTC is dumping — beware',
        state: 'Cash',
        h: 0.2,
      }),
    ).toBe('BTC is dumping — beware')
    expect(
      formatClimateRegimeDetail({
        headline: 'Mixed tape',
        state: 'Mixed',
        h: 0.4,
      }),
    ).toBe('Mixed tape')
  })

  it('falls back to state · H when headline is missing (old terminals)', () => {
    expect(formatClimateRegimeDetail({ state: 'De-risk', h: 0.48 })).toBe(
      'De-risk · H 0.5',
    )
    expect(formatClimateRegimeDetail({ state: 'Range', h: 0.91 })).toBe(
      'Range · H 0.9',
    )
    expect(formatClimateRegimeDetail({ state: 'Mixed', h: 0.4 })).toBe(
      'Mixed · H 0.4',
    )
    expect(formatClimateRegimeDetail({ state: null, h: 0.5 })).toBe('H 0.5')
    expect(formatClimateRegimeDetail({ state: '  ', h: null })).toBeNull()
    expect(
      formatClimateRegimeDetail({ headline: '  ', state: 'Range', h: 0.5 }),
    ).toBe('Range · H 0.5')
  })
})

describe('formatClimateRegimeTooltip', () => {
  it('prefers terminal detail and keeps H in the tooltip', () => {
    expect(
      formatClimateRegimeTooltip({
        label: 'Safe',
        headline: 'Chop mode',
        detail: "Range-bound — don't chase.",
        state: 'Range',
        h: 0.52,
      }),
    ).toBe("Safe. Range-bound — don't chase. (H 0.5). Display only.")
    expect(
      formatClimateRegimeTooltip({
        label: 'Not safe',
        headline: 'BTC is dumping — beware',
        detail: 'Stand down until the tape settles.',
        state: 'Cash',
        h: 0.21,
      }),
    ).toBe(
      'Not safe. Stand down until the tape settles. (H 0.2). Display only — does not block trades.',
    )
  })

  it('falls back to chip subtitle when detail is missing', () => {
    expect(
      formatClimateRegimeTooltip({
        label: 'Not safe',
        state: 'De-risk',
        h: 0.48,
      }),
    ).toBe('Not safe (De-risk · H 0.5). Display only — does not block trades.')
    expect(
      formatClimateRegimeTooltip({
        label: 'Unknown',
      }),
    ).toBe(
      'Regime climate unknown (fetch failed or stale). Display only — does not block trades.',
    )
  })
})
