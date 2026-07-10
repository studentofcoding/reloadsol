import type { StrategyParameterSet } from './canonical-params'
import {
  applyTierRule,
  getDefaultPotentialExitOverlayConfig,
  loadPotentialExitOverlayConfig,
  type PotentialExitOverlayConfig,
} from './potential-exit-overlay-config'

export type PotentialExitMode = 'off' | 'shadow' | 'apply'

export type CanonicalExit = StrategyParameterSet['exit']

export type PotentialExitSignals = {
  tier?: number | null
  moonScore?: number | null
  pWinner?: number | null
}

export type PotentialExitOverlayMeta = {
  source: 'potential_tier' | 'identity'
  mode: PotentialExitMode
  tier: number | null
  moonScore: number | null
  pWinner: number | null
  base: CanonicalExit
  effective: CanonicalExit
  applied: boolean
  configVersion?: number
}

export type ApplyPotentialToExitParamsResult = {
  exit: CanonicalExit
  overlay: PotentialExitOverlayMeta
}

export function getMlPotentialExitModeFromEnv(): PotentialExitMode {
  const mode = process.env.ML_POTENTIAL_EXIT_MODE?.toLowerCase()
  if (mode === 'apply') return 'apply'
  if (mode === 'off') return 'off'
  return 'shadow'
}

/** Env mode, optionally overridden by admin config. */
export function getMlPotentialExitMode(
  exitModeOverride?: PotentialExitMode | null,
): PotentialExitMode {
  if (
    exitModeOverride === 'apply' ||
    exitModeOverride === 'off' ||
    exitModeOverride === 'shadow'
  ) {
    return exitModeOverride
  }
  return getMlPotentialExitModeFromEnv()
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function cloneExit(exit: CanonicalExit): CanonicalExit {
  return {
    stopLossPct: exit.stopLossPct,
    takeProfitPct: exit.takeProfitPct,
    maxHoldHours: exit.maxHoldHours,
    ...(exit.takeProfitLadder ? { takeProfitLadder: [...exit.takeProfitLadder] } : {}),
    ...(exit.oorTimeoutMin != null ? { oorTimeoutMin: exit.oorTimeoutMin } : {}),
  }
}

function readNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

/** Extract ML2 / Pattern signals from entry_features. */
export function readPotentialExitSignals(
  features: Record<string, unknown> | null | undefined,
): PotentialExitSignals {
  if (!features) return {}
  return {
    tier: readNum(features.ml_potential_tier),
    moonScore: readNum(features.ml_potential_moon_score),
    pWinner: readNum(features.ml_pattern_p_winner),
  }
}

/**
 * Map potential tier / moonScore / pWinner onto canonical exit params.
 * Pure function — mode gating is caller's responsibility for persistence.
 */
export function applyPotentialToExitParams(
  baseExit: CanonicalExit,
  signals: PotentialExitSignals,
  opts?: {
    config?: PotentialExitOverlayConfig
    mode?: PotentialExitMode
  },
): ApplyPotentialToExitParamsResult {
  const config = opts?.config ?? getDefaultPotentialExitOverlayConfig()
  const mode = opts?.mode ?? getMlPotentialExitMode(config.exitModeOverride)
  const base = cloneExit(baseExit)
  const tier =
    signals.tier != null && signals.tier >= 1 && signals.tier <= 4
      ? Math.round(signals.tier)
      : null
  const moonScore =
    signals.moonScore != null && Number.isFinite(signals.moonScore)
      ? signals.moonScore
      : null
  const pWinner =
    signals.pWinner != null && Number.isFinite(signals.pWinner)
      ? signals.pWinner
      : null

  const promote3 = config.moonScorePromote.tier3
  const promote4 = config.moonScorePromote.tier4

  if (tier == null && (moonScore == null || moonScore < promote3)) {
    return {
      exit: base,
      overlay: {
        source: 'identity',
        mode,
        tier,
        moonScore,
        pWinner,
        base,
        effective: cloneExit(base),
        applied: false,
        configVersion: config.version,
      },
    }
  }

  let effectiveTier = tier
  if (effectiveTier == null && moonScore != null) {
    if (moonScore >= promote4) effectiveTier = 4
    else if (moonScore >= promote3) effectiveTier = 3
  }

  let takeProfitPct = base.takeProfitPct
  let stopLossPct = base.stopLossPct
  let maxHoldHours = base.maxHoldHours

  if (effectiveTier === 1 || effectiveTier === 2 || effectiveTier === 3 || effectiveTier === 4) {
    const applied = applyTierRule(
      takeProfitPct,
      stopLossPct,
      maxHoldHours,
      config.tiers[effectiveTier],
    )
    takeProfitPct = applied.takeProfitPct
    stopLossPct = applied.stopLossPct
    maxHoldHours = applied.maxHoldHours
  }

  const nudge = config.pWinnerNudge
  if (
    pWinner != null &&
    pWinner >= nudge.min &&
    (effectiveTier ?? 0) >= nudge.minTier
  ) {
    takeProfitPct += nudge.tpBonus
  }

  takeProfitPct = clamp(takeProfitPct, config.clamps.tpMin, config.clamps.tpMax)
  stopLossPct = clamp(stopLossPct, config.clamps.slMin, config.clamps.slMax)

  let takeProfitLadder = base.takeProfitLadder
  if (takeProfitLadder && takeProfitLadder.length > 0 && base.takeProfitPct > 0) {
    const scale = takeProfitPct / base.takeProfitPct
    takeProfitLadder = takeProfitLadder.map((level, i) => {
      if (i === 0) return takeProfitPct
      return clamp(level * scale, config.clamps.tpMin, config.clamps.tpMax)
    })
  }

  const effective: CanonicalExit = {
    stopLossPct,
    takeProfitPct,
    maxHoldHours,
    ...(takeProfitLadder ? { takeProfitLadder } : {}),
    ...(base.oorTimeoutMin != null ? { oorTimeoutMin: base.oorTimeoutMin } : {}),
  }

  return {
    exit: effective,
    overlay: {
      source: 'potential_tier',
      mode,
      tier,
      moonScore,
      pWinner,
      base,
      effective: cloneExit(effective),
      applied: false,
      configVersion: config.version,
    },
  }
}

/** Merge overlay audit fields into entry_features. */
export function mergeExitOverlayIntoEntryFeatures(
  features: Record<string, unknown>,
  overlay: PotentialExitOverlayMeta,
  opts?: { persistApplied?: boolean },
): Record<string, unknown> {
  const applied = opts?.persistApplied === true && overlay.mode === 'apply'
  return {
    ...features,
    ml_exit_overlay_mode: overlay.mode,
    ml_exit_overlay_source: overlay.source,
    ml_exit_overlay_at: new Date().toISOString(),
    ml_exit_overlay_applied: applied,
    ml_exit_overlay_config_version: overlay.configVersion ?? 1,
    ml_exit_base_stop_loss_pct: overlay.base.stopLossPct,
    ml_exit_base_take_profit_pct: overlay.base.takeProfitPct,
    ml_exit_base_max_hold_hours: overlay.base.maxHoldHours,
    ml_exit_effective_stop_loss_pct: overlay.effective.stopLossPct,
    ml_exit_effective_take_profit_pct: overlay.effective.takeProfitPct,
    ml_exit_effective_max_hold_hours: overlay.effective.maxHoldHours,
    ml_exit_overlay_tier: overlay.tier,
    ml_exit_overlay_moon_score: overlay.moonScore,
    ml_exit_overlay_p_winner: overlay.pWinner,
  }
}

export function logPotentialExitCounterfactual(input: {
  mintAddress: string
  strategyId: string
  overlay: PotentialExitOverlayMeta
}): void {
  const { overlay } = input
  const changed =
    overlay.base.takeProfitPct !== overlay.effective.takeProfitPct ||
    overlay.base.stopLossPct !== overlay.effective.stopLossPct ||
    overlay.base.maxHoldHours !== overlay.effective.maxHoldHours
  if (!changed && overlay.source === 'identity') return

  console.info('[ml-potential-exit:counterfactual]', {
    mint: input.mintAddress,
    strategy: input.strategyId,
    mode: overlay.mode,
    source: overlay.source,
    tier: overlay.tier,
    moon_score: overlay.moonScore,
    p_winner: overlay.pWinner,
    base: {
      tp: overlay.base.takeProfitPct,
      sl: overlay.base.stopLossPct,
      hold: overlay.base.maxHoldHours,
    },
    effective: {
      tp: overlay.effective.takeProfitPct,
      sl: overlay.effective.stopLossPct,
      hold: overlay.effective.maxHoldHours,
    },
    at: new Date().toISOString(),
  })
}

export type EffectiveExitSnapshot = {
  stopLossPct: number
  takeProfitPct: number
  maxHoldHours: number
}

export function readEffectiveExitFromSimulation(
  sim: Record<string, unknown> | null | undefined,
): EffectiveExitSnapshot | null {
  if (!sim) return null
  const raw = sim.effective_exit
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const stopLossPct = readNum(e.stopLossPct)
  const takeProfitPct = readNum(e.takeProfitPct)
  const maxHoldHours = readNum(e.maxHoldHours)
  if (stopLossPct == null || takeProfitPct == null || maxHoldHours == null) return null
  return { stopLossPct, takeProfitPct, maxHoldHours }
}

/**
 * Run overlay for open path: stamp audit always; return exit to persist when mode=apply
 * and persistEffectiveExit is true (sim only — never for live).
 */
export async function resolveExitOverlayForOpen(params: {
  baseExit: CanonicalExit
  features: Record<string, unknown>
  mintAddress: string
  strategyId: string
  /** When false (live), never persist effective_exit even if mode=apply */
  persistEffectiveExit?: boolean
}): Promise<{
  features: Record<string, unknown>
  effectiveExit: EffectiveExitSnapshot | null
  overlay: PotentialExitOverlayMeta
}> {
  const config = await loadPotentialExitOverlayConfig()
  const mode = getMlPotentialExitMode(config.exitModeOverride)

  if (mode === 'off') {
    return {
      features: params.features,
      effectiveExit: null,
      overlay: {
        source: 'identity',
        mode: 'off',
        tier: null,
        moonScore: null,
        pWinner: null,
        base: { ...params.baseExit },
        effective: { ...params.baseExit },
        applied: false,
        configVersion: config.version,
      },
    }
  }

  const canPersist = params.persistEffectiveExit !== false
  const signals = readPotentialExitSignals(params.features)
  const { exit, overlay } = applyPotentialToExitParams(params.baseExit, signals, {
    config,
    mode,
  })
  const applied = mode === 'apply' && canPersist
  const meta: PotentialExitOverlayMeta = { ...overlay, mode, applied }

  logPotentialExitCounterfactual({
    mintAddress: params.mintAddress,
    strategyId: params.strategyId,
    overlay: meta,
  })

  const features = mergeExitOverlayIntoEntryFeatures(params.features, meta, {
    persistApplied: applied,
  })

  const effectiveExit: EffectiveExitSnapshot | null = applied
    ? {
        stopLossPct: exit.stopLossPct,
        takeProfitPct: exit.takeProfitPct,
        maxHoldHours: exit.maxHoldHours,
      }
    : null

  return { features, effectiveExit, overlay: meta }
}
