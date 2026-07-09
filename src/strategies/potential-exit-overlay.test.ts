import { afterEach, describe, expect, it } from 'vitest'
import {
  applyPotentialToExitParams,
  getMlPotentialExitMode,
  mergeExitOverlayIntoEntryFeatures,
  resolveExitOverlayForOpen,
} from './potential-exit-overlay'

const BASE = {
  stopLossPct: -50,
  takeProfitPct: 200,
  maxHoldHours: 96,
}

afterEach(() => {
  delete process.env.ML_POTENTIAL_EXIT_MODE
})

describe('getMlPotentialExitMode', () => {
  it('defaults to shadow', () => {
    expect(getMlPotentialExitMode()).toBe('shadow')
  })

  it('reads apply and off', () => {
    process.env.ML_POTENTIAL_EXIT_MODE = 'apply'
    expect(getMlPotentialExitMode()).toBe('apply')
    process.env.ML_POTENTIAL_EXIT_MODE = 'off'
    expect(getMlPotentialExitMode()).toBe('off')
  })
})

describe('applyPotentialToExitParams', () => {
  it('returns identity when no ML signals', () => {
    const { exit, overlay } = applyPotentialToExitParams(BASE, {})
    expect(exit).toEqual(BASE)
    expect(overlay.source).toBe('identity')
    expect(overlay.applied).toBe(false)
  })

  it('tightens tier 1 TP/SL', () => {
    const { exit } = applyPotentialToExitParams(BASE, { tier: 1 })
    expect(exit.takeProfitPct).toBe(100)
    expect(exit.stopLossPct).toBe(-35)
    expect(exit.maxHoldHours).toBe(96)
  })

  it('leaves tier 2 at baseline', () => {
    const { exit } = applyPotentialToExitParams(BASE, { tier: 2 })
    expect(exit.takeProfitPct).toBe(200)
    expect(exit.stopLossPct).toBe(-50)
  })

  it('widens tier 3 TP and hold', () => {
    const { exit } = applyPotentialToExitParams(BASE, { tier: 3 })
    expect(exit.takeProfitPct).toBe(250)
    expect(exit.stopLossPct).toBe(-50)
    expect(exit.maxHoldHours).toBe(120)
  })

  it('widens tier 4 TP/SL/hold', () => {
    const { exit } = applyPotentialToExitParams(BASE, { tier: 4 })
    expect(exit.takeProfitPct).toBe(350)
    expect(exit.stopLossPct).toBe(-60)
    expect(exit.maxHoldHours).toBe(144)
  })

  it('nudges TP when pWinner high and tier >= 2', () => {
    const { exit } = applyPotentialToExitParams(BASE, { tier: 2, pWinner: 0.7 })
    expect(exit.takeProfitPct).toBe(225)
  })

  it('clamps TP and SL', () => {
    const { exit } = applyPotentialToExitParams(
      { stopLossPct: -10, takeProfitPct: 40, maxHoldHours: 24 },
      { tier: 4 },
    )
    expect(exit.takeProfitPct).toBeGreaterThanOrEqual(50)
    expect(exit.takeProfitPct).toBeLessThanOrEqual(500)
    expect(exit.stopLossPct).toBeGreaterThanOrEqual(-80)
    expect(exit.stopLossPct).toBeLessThanOrEqual(-20)
  })

  it('scales takeProfitLadder from TP1', () => {
    const { exit } = applyPotentialToExitParams(
      {
        stopLossPct: -35,
        takeProfitPct: 45,
        takeProfitLadder: [45, 100],
        maxHoldHours: 24,
      },
      { tier: 3 },
    )
    expect(exit.takeProfitPct).toBe(250)
    expect(exit.takeProfitLadder?.[0]).toBe(250)
    expect(exit.takeProfitLadder?.[1]).toBeGreaterThan(100)
  })
})

describe('resolveExitOverlayForOpen', () => {
  it('stamps audit fields in shadow without effective_exit', () => {
    process.env.ML_POTENTIAL_EXIT_MODE = 'shadow'
    const result = resolveExitOverlayForOpen({
      baseExit: BASE,
      features: { ml_potential_tier: 3, ml_potential_moon_score: 0.5 },
      mintAddress: 'mint',
      strategyId: 'mcap_enter_first_seen',
      persistEffectiveExit: true,
    })
    expect(result.effectiveExit).toBeNull()
    expect(result.features.ml_exit_overlay_mode).toBe('shadow')
    expect(result.features.ml_exit_overlay_applied).toBe(false)
    expect(result.features.ml_exit_effective_take_profit_pct).toBe(250)
    expect(result.features.ml_exit_base_take_profit_pct).toBe(200)
  })

  it('persists effective_exit when mode=apply and persist allowed', () => {
    process.env.ML_POTENTIAL_EXIT_MODE = 'apply'
    const result = resolveExitOverlayForOpen({
      baseExit: BASE,
      features: { ml_potential_tier: 4 },
      mintAddress: 'mint',
      strategyId: 'mcap_enter_at_80',
      persistEffectiveExit: true,
    })
    expect(result.effectiveExit).toEqual({
      stopLossPct: -60,
      takeProfitPct: 350,
      maxHoldHours: 144,
    })
    expect(result.features.ml_exit_overlay_applied).toBe(true)
  })

  it('never persists effective_exit for live even when apply', () => {
    process.env.ML_POTENTIAL_EXIT_MODE = 'apply'
    const result = resolveExitOverlayForOpen({
      baseExit: BASE,
      features: { ml_potential_tier: 4 },
      mintAddress: 'mint',
      strategyId: 'mcap_enter_at_80',
      persistEffectiveExit: false,
    })
    expect(result.effectiveExit).toBeNull()
    expect(result.features.ml_exit_overlay_applied).toBe(false)
    expect(result.features.ml_exit_effective_take_profit_pct).toBe(350)
  })
})

describe('mergeExitOverlayIntoEntryFeatures', () => {
  it('writes ml_exit_* keys', () => {
    const { overlay } = applyPotentialToExitParams(BASE, { tier: 1 })
    const feats = mergeExitOverlayIntoEntryFeatures({ a: 1 }, overlay)
    expect(feats.a).toBe(1)
    expect(feats.ml_exit_base_stop_loss_pct).toBe(-50)
    expect(feats.ml_exit_effective_stop_loss_pct).toBe(-35)
  })
})
