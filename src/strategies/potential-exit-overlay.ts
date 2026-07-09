import type { StrategyParameterSet } from './canonical-params'

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
}

export type ApplyPotentialToExitParamsResult = {
  exit: CanonicalExit
  overlay: PotentialExitOverlayMeta
}

const TP_MIN = 50
const TP_MAX = 500
const SL_MIN = -80
const SL_MAX = -20

export function getMlPotentialExitMode(): PotentialExitMode {
  const mode = process.env.ML_POTENTIAL_EXIT_MODE?.toLowerCase()
  if (mode === 'apply') return 'apply'
  if (mode === 'off') return 'off'
  return 'shadow'
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
): ApplyPotentialToExitParamsResult {
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

  const mode = getMlPotentialExitMode()

  if (tier == null && (moonScore == null || moonScore < 0.45)) {
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
      },
    }
  }

  let takeProfitPct = base.takeProfitPct
  let stopLossPct = base.stopLossPct
  let maxHoldHours = base.maxHoldHours

  // Prefer explicit tier; moonScore can promote to 3/4 when tier missing
  let effectiveTier = tier
  if (effectiveTier == null && moonScore != null) {
    if (moonScore >= 0.65) effectiveTier = 4
    else if (moonScore >= 0.45) effectiveTier = 3
  }

  if (effectiveTier === 1) {
    takeProfitPct = Math.min(base.takeProfitPct, 100)
    stopLossPct = Math.max(base.stopLossPct, -35)
  } else if (effectiveTier === 3) {
    takeProfitPct = Math.max(base.takeProfitPct, 250)
    maxHoldHours = Math.min(base.maxHoldHours + 24, 120)
  } else if (effectiveTier === 4) {
    takeProfitPct = Math.max(base.takeProfitPct, 350)
    stopLossPct = Math.min(base.stopLossPct, -60)
    maxHoldHours = Math.min(base.maxHoldHours + 48, 144)
  }
  // tier 2 = baseline (unchanged)

  if (pWinner != null && pWinner >= 0.6 && (effectiveTier ?? 0) >= 2) {
    takeProfitPct += 25
  }

  takeProfitPct = clamp(takeProfitPct, TP_MIN, TP_MAX)
  stopLossPct = clamp(stopLossPct, SL_MIN, SL_MAX)

  let takeProfitLadder = base.takeProfitLadder
  if (takeProfitLadder && takeProfitLadder.length > 0 && base.takeProfitPct > 0) {
    const scale = takeProfitPct / base.takeProfitPct
    takeProfitLadder = takeProfitLadder.map((level, i) => {
      if (i === 0) return takeProfitPct
      return clamp(level * scale, TP_MIN, TP_MAX)
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
export function resolveExitOverlayForOpen(params: {
  baseExit: CanonicalExit
  features: Record<string, unknown>
  mintAddress: string
  strategyId: string
  /** When false (live), never persist effective_exit even if mode=apply */
  persistEffectiveExit?: boolean
}): {
  features: Record<string, unknown>
  effectiveExit: EffectiveExitSnapshot | null
  overlay: PotentialExitOverlayMeta
} {
  const mode = getMlPotentialExitMode()
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
      },
    }
  }

  const canPersist = params.persistEffectiveExit !== false
  const signals = readPotentialExitSignals(params.features)
  const { exit, overlay } = applyPotentialToExitParams(params.baseExit, signals)
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
