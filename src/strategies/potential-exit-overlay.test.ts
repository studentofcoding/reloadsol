import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyPotentialToExitParams,
  getMlPotentialExitMode,
  getMlPotentialExitModeFromEnv,
  mergeExitOverlayIntoEntryFeatures,
  resolveExitOverlayForOpen,
} from './potential-exit-overlay'
import {
  getDefaultPotentialExitOverlayConfig,
  parsePotentialExitOverlayConfig,
  previewOverlayForBase,
} from './potential-exit-overlay-config'

const BASE = {
  stopLossPct: -50,
  takeProfitPct: 200,
  maxHoldHours: 96,
}

afterEach(() => {
  delete process.env.ML_POTENTIAL_EXIT_MODE
  vi.restoreAllMocks()
})

describe('getMlPotentialExitMode', () => {
  it('defaults to shadow from env', () => {
    expect(getMlPotentialExitModeFromEnv()).toBe('shadow')
    expect(getMlPotentialExitMode()).toBe('shadow')
  })

  it('reads apply and off from env', () => {
    process.env.ML_POTENTIAL_EXIT_MODE = 'apply'
    expect(getMlPotentialExitMode()).toBe('apply')
    process.env.ML_POTENTIAL_EXIT_MODE = 'off'
    expect(getMlPotentialExitMode()).toBe('off')
  })

  it('admin override beats env', () => {
    process.env.ML_POTENTIAL_EXIT_MODE = 'shadow'
    expect(getMlPotentialExitMode('apply')).toBe('apply')
    expect(getMlPotentialExitMode('off')).toBe('off')
  })
})

describe('applyPotentialToExitParams defaults parity', () => {
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

  it('uses custom config tier rules', () => {
    const config = getDefaultPotentialExitOverlayConfig()
    config.tiers[3] = { takeProfitMin: 300, maxHoldHoursDelta: 10, maxHoldHoursCap: 200 }
    const { exit } = applyPotentialToExitParams(BASE, { tier: 3 }, { config })
    expect(exit.takeProfitPct).toBe(300)
    expect(exit.maxHoldHours).toBe(106)
  })
})

describe('parsePotentialExitOverlayConfig', () => {
  it('falls back to defaults on empty', () => {
    const c = parsePotentialExitOverlayConfig({})
    expect(c.tiers[1].takeProfitMax).toBe(100)
    expect(c.exitModeOverride).toBeNull()
  })

  it('parses exitModeOverride', () => {
    const c = parsePotentialExitOverlayConfig({ exitModeOverride: 'apply' })
    expect(c.exitModeOverride).toBe('apply')
  })
})

describe('previewOverlayForBase', () => {
  it('matches default tier 1', () => {
    const p = previewOverlayForBase(
      getDefaultPotentialExitOverlayConfig(),
      BASE,
      1,
    )
    expect(p.takeProfitPct).toBe(100)
    expect(p.stopLossPct).toBe(-35)
  })
})

describe('resolveExitOverlayForOpen', () => {
  it('stamps audit fields in shadow without effective_exit', async () => {
    process.env.ML_POTENTIAL_EXIT_MODE = 'shadow'
    vi.spyOn(
      await import('./potential-exit-overlay-config'),
      'loadPotentialExitOverlayConfig',
    ).mockResolvedValue(getDefaultPotentialExitOverlayConfig())

    const result = await resolveExitOverlayForOpen({
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
  })

  it('persists effective_exit when mode=apply and persist allowed', async () => {
    process.env.ML_POTENTIAL_EXIT_MODE = 'apply'
    vi.spyOn(
      await import('./potential-exit-overlay-config'),
      'loadPotentialExitOverlayConfig',
    ).mockResolvedValue(getDefaultPotentialExitOverlayConfig())

    const result = await resolveExitOverlayForOpen({
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

  it('never persists effective_exit for live even when apply', async () => {
    process.env.ML_POTENTIAL_EXIT_MODE = 'apply'
    vi.spyOn(
      await import('./potential-exit-overlay-config'),
      'loadPotentialExitOverlayConfig',
    ).mockResolvedValue(getDefaultPotentialExitOverlayConfig())

    const result = await resolveExitOverlayForOpen({
      baseExit: BASE,
      features: { ml_potential_tier: 4 },
      mintAddress: 'mint',
      strategyId: 'mcap_enter_at_80',
      persistEffectiveExit: false,
    })
    expect(result.effectiveExit).toBeNull()
    expect(result.features.ml_exit_overlay_applied).toBe(false)
  })

  it('honors config exitModeOverride over env', async () => {
    process.env.ML_POTENTIAL_EXIT_MODE = 'shadow'
    const config = getDefaultPotentialExitOverlayConfig()
    config.exitModeOverride = 'apply'
    vi.spyOn(
      await import('./potential-exit-overlay-config'),
      'loadPotentialExitOverlayConfig',
    ).mockResolvedValue(config)

    const result = await resolveExitOverlayForOpen({
      baseExit: BASE,
      features: { ml_potential_tier: 3 },
      mintAddress: 'mint',
      strategyId: 'mcap_enter_first_seen',
      persistEffectiveExit: true,
    })
    expect(result.effectiveExit?.takeProfitPct).toBe(250)
    expect(result.features.ml_exit_overlay_mode).toBe('apply')
  })
})

describe('mergeExitOverlayIntoEntryFeatures', () => {
  it('writes ml_exit_* keys', () => {
    const { overlay } = applyPotentialToExitParams(BASE, { tier: 1 })
    const feats = mergeExitOverlayIntoEntryFeatures({ a: 1 }, overlay)
    expect(feats.a).toBe(1)
    expect(feats.ml_exit_base_stop_loss_pct).toBe(-50)
    expect(feats.ml_exit_effective_stop_loss_pct).toBe(-35)
    expect(feats.ml_exit_overlay_config_version).toBe(1)
  })
})
