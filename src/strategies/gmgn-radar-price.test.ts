import { describe, expect, it } from 'vitest'
import {
  applyRadarPriceRules,
  computeRadarPriceGrowth,
  extractRadarPriceStateFromEvents,
} from './gmgn-radar-price'

describe('gmgn-radar-price', () => {
  it('computes growth pct', () => {
    expect(computeRadarPriceGrowth(1.5, 1)).toBeCloseTo(50)
    expect(computeRadarPriceGrowth(0.2, 1)).toBeCloseTo(-80)
    expect(computeRadarPriceGrowth(1, null)).toBeNull()
  })

  it('pump >50% forces WATCH and sets sticky baseline to previous', () => {
    const r = applyRadarPriceRules({
      action: 'ENTER',
      growthPct: 60,
      stickyBaselineUsd: null,
      currentPriceUsd: 1.6,
      previousPriceUsd: 1,
    })
    expect(r.action).toBe('WATCH')
    expect(r.stickyBaselineUsd).toBe(1)
    expect(r.banned).toBe(false)
  })

  it('keeps WATCH while above sticky baseline', () => {
    const r = applyRadarPriceRules({
      action: 'ENTER',
      radarScore: 40,
      growthPct: 10,
      stickyBaselineUsd: 1,
      stickySinceIso: new Date().toISOString(),
      currentPriceUsd: 1.2,
      previousPriceUsd: 1.1,
    })
    expect(r.action).toBe('WATCH')
    expect(r.stickyBaselineUsd).toBe(1)
  })

  it('allows scored ENTER when sticky score override fires', () => {
    const r = applyRadarPriceRules({
      action: 'ENTER',
      radarScore: 60,
      growthPct: 10,
      stickyBaselineUsd: 1,
      stickySinceIso: new Date().toISOString(),
      currentPriceUsd: 1.2,
      previousPriceUsd: 1.1,
      enterOverrideMinScore: 55,
    })
    expect(r.action).toBe('ENTER')
    expect(r.stickyBaselineUsd).toBe(1)
    expect(r.reasons.some((x) => x.includes('sticky override'))).toBe(true)
  })

  it('clears sticky force after TTL', () => {
    const now = Date.now()
    const r = applyRadarPriceRules({
      action: 'ENTER',
      radarScore: 40,
      growthPct: 10,
      stickyBaselineUsd: 1,
      stickySinceIso: new Date(now - 50 * 60_000).toISOString(),
      currentPriceUsd: 1.2,
      previousPriceUsd: 1.1,
      stickyTtlMinutes: 45,
      nowMs: now,
    })
    expect(r.action).toBe('ENTER')
    expect(r.stickyBaselineUsd).toBeNull()
    expect(r.stickySinceIso).toBeNull()
  })

  it('clears sticky when back to ≤0% vs baseline', () => {
    const r = applyRadarPriceRules({
      action: 'ENTER',
      growthPct: -5,
      stickyBaselineUsd: 1,
      stickySinceIso: new Date().toISOString(),
      currentPriceUsd: 0.95,
      previousPriceUsd: 1.1,
    })
    expect(r.stickyBaselineUsd).toBeNull()
    expect(r.stickySinceIso).toBeNull()
    expect(r.action).toBe('ENTER')
    expect(r.banned).toBe(false)
  })

  it('dump ≤-80% bans and SKIP', () => {
    const r = applyRadarPriceRules({
      action: 'ENTER',
      growthPct: -85,
      stickyBaselineUsd: 1,
      currentPriceUsd: 0.15,
      previousPriceUsd: 1,
    })
    expect(r.banned).toBe(true)
    expect(r.action).toBe('SKIP')
    expect(r.stickyBaselineUsd).toBeNull()
  })

  it('extracts previous price, mcap and sticky from events', () => {
    const state = extractRadarPriceStateFromEvents([
      {
        raw_metadata: {
          radar_price_usd: 2,
          radar_mcap_usd: 80_000,
          radar_watch_baseline_usd: 1.2,
          radar_sticky_since_iso: '2026-07-13T10:00:00.000Z',
        },
      },
      { raw_metadata: { radar_price_usd: 1, radar_mcap_usd: 40_000 } },
    ])
    expect(state.previousPriceUsd).toBe(2)
    expect(state.previousMcapUsd).toBe(80_000)
    expect(state.stickyBaselineUsd).toBe(1.2)
    expect(state.stickySinceIso).toBe('2026-07-13T10:00:00.000Z')
  })
})
