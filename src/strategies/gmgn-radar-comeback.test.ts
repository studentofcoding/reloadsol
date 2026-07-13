import { describe, expect, it } from 'vitest'
import {
  evaluateRadarComeback,
  evaluateRadarDrawdownDeath,
  pctChange,
} from './gmgn-radar-comeback'
import { DEFAULT_GMGN_RADAR } from './registry'

const cfg = DEFAULT_GMGN_RADAR.comeback

describe('gmgn-radar-comeback', () => {
  it('marks drawdown death when drop ≥ drawdownPct', () => {
    const r = evaluateRadarDrawdownDeath({
      config: cfg,
      peakMcapUsd: 100_000,
      currentMcapUsd: 20_000,
    })
    expect(r.isDead).toBe(true)
    expect(r.reasons.length).toBeGreaterThan(0)
  })

  it('marks death when mcap hits trough floor after higher peak', () => {
    const r = evaluateRadarDrawdownDeath({
      config: cfg,
      peakMcapUsd: 80_000,
      currentMcapUsd: 25_000,
    })
    expect(r.isDead).toBe(true)
  })

  it('does not mark death on mild pullback', () => {
    expect(
      evaluateRadarDrawdownDeath({
        config: cfg,
        peakMcapUsd: 100_000,
        currentMcapUsd: 80_000,
      }).isDead,
    ).toBe(false)
  })

  it('comeback when recovered from trough after dead lifecycle', () => {
    const r = evaluateRadarComeback({
      config: cfg,
      radarScore: 50,
      troughMcapUsd: 20_000,
      currentMcapUsd: 40_000,
      hasDeadLifecycle: true,
    })
    expect(r.isComeback).toBe(true)
  })

  it('no comeback below recover multiple', () => {
    expect(
      evaluateRadarComeback({
        config: cfg,
        radarScore: 50,
        troughMcapUsd: 20_000,
        currentMcapUsd: 25_000,
        hasDeadLifecycle: true,
      }).isComeback,
    ).toBe(false)
  })

  it('no comeback without dead lifecycle', () => {
    expect(
      evaluateRadarComeback({
        config: cfg,
        radarScore: 80,
        troughMcapUsd: 20_000,
        currentMcapUsd: 50_000,
        hasDeadLifecycle: false,
      }).isComeback,
    ).toBe(false)
  })

  it('disabled config yields no death/comeback', () => {
    const off = { ...cfg, enabled: false }
    expect(
      evaluateRadarDrawdownDeath({
        config: off,
        peakMcapUsd: 100_000,
        currentMcapUsd: 10_000,
      }).isDead,
    ).toBe(false)
    expect(
      evaluateRadarComeback({
        config: off,
        radarScore: 80,
        troughMcapUsd: 10_000,
        currentMcapUsd: 50_000,
        hasDeadLifecycle: true,
      }).isComeback,
    ).toBe(false)
  })

  it('pctChange vs last', () => {
    expect(pctChange(150, 100)).toBeCloseTo(50)
    expect(pctChange(50, 100)).toBeCloseTo(-50)
    expect(pctChange(1, null)).toBeNull()
  })
})
