import type { PotentialExitMode } from './potential-exit-overlay'

export const ML2_EXIT_OVERLAY_STRATEGY_ID = 'ml2_exit_overlay'

export type TierExitRule = {
  /** Absolute TP target (replaces base when set) */
  takeProfitPct?: number | null
  /** max(base, x) */
  takeProfitMin?: number | null
  /** min(base, x) */
  takeProfitMax?: number | null
  stopLossPct?: number | null
  /** max(base, x) — tighter SL e.g. -35 */
  stopLossTighter?: number | null
  /** min(base, x) — wider SL e.g. -60 */
  stopLossWider?: number | null
  maxHoldHoursDelta?: number | null
  maxHoldHoursCap?: number | null
}

export type PotentialExitOverlayConfig = {
  version: 1
  clamps: { tpMin: number; tpMax: number; slMin: number; slMax: number }
  moonScorePromote: { tier3: number; tier4: number }
  pWinnerNudge: { min: number; tpBonus: number; minTier: number }
  tiers: {
    1: TierExitRule
    2: TierExitRule
    3: TierExitRule
    4: TierExitRule
  }
  /** Admin override; null/undefined → use ML_POTENTIAL_EXIT_MODE env */
  exitModeOverride?: PotentialExitMode | null
}

/** Matches hard-coded Phase B table. */
export function getDefaultPotentialExitOverlayConfig(): PotentialExitOverlayConfig {
  return {
    version: 1,
    clamps: { tpMin: 50, tpMax: 500, slMin: -80, slMax: -20 },
    moonScorePromote: { tier3: 0.45, tier4: 0.65 },
    pWinnerNudge: { min: 0.6, tpBonus: 25, minTier: 2 },
    tiers: {
      1: {
        takeProfitMax: 100,
        stopLossTighter: -35,
      },
      2: {},
      3: {
        takeProfitMin: 250,
        maxHoldHoursDelta: 24,
        maxHoldHoursCap: 120,
      },
      4: {
        takeProfitMin: 350,
        stopLossWider: -60,
        maxHoldHoursDelta: 48,
        maxHoldHoursCap: 144,
      },
    },
    exitModeOverride: null,
  }
}

function readFinite(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

function mergeTierRule(
  base: TierExitRule,
  patch: Record<string, unknown> | null | undefined,
): TierExitRule {
  if (!patch || typeof patch !== 'object') return { ...base }
  return {
    takeProfitPct: readFinite(patch.takeProfitPct) ?? base.takeProfitPct ?? null,
    takeProfitMin: readFinite(patch.takeProfitMin) ?? base.takeProfitMin ?? null,
    takeProfitMax: readFinite(patch.takeProfitMax) ?? base.takeProfitMax ?? null,
    stopLossPct: readFinite(patch.stopLossPct) ?? base.stopLossPct ?? null,
    stopLossTighter: readFinite(patch.stopLossTighter) ?? base.stopLossTighter ?? null,
    stopLossWider: readFinite(patch.stopLossWider) ?? base.stopLossWider ?? null,
    maxHoldHoursDelta:
      readFinite(patch.maxHoldHoursDelta) ?? base.maxHoldHoursDelta ?? null,
    maxHoldHoursCap: readFinite(patch.maxHoldHoursCap) ?? base.maxHoldHoursCap ?? null,
  }
}

function parseExitModeOverride(v: unknown): PotentialExitMode | null {
  if (v === 'shadow' || v === 'apply' || v === 'off') return v
  if (v === null || v === undefined || v === '') return null
  return null
}

/** Merge raw DB/API payload onto defaults; invalid fields fall back. */
export function parsePotentialExitOverlayConfig(
  raw: Record<string, unknown> | null | undefined,
): PotentialExitOverlayConfig {
  const defaults = getDefaultPotentialExitOverlayConfig()
  if (!raw || typeof raw !== 'object') return defaults

  const clampsRaw =
    raw.clamps && typeof raw.clamps === 'object'
      ? (raw.clamps as Record<string, unknown>)
      : {}
  const moonRaw =
    raw.moonScorePromote && typeof raw.moonScorePromote === 'object'
      ? (raw.moonScorePromote as Record<string, unknown>)
      : {}
  const nudgeRaw =
    raw.pWinnerNudge && typeof raw.pWinnerNudge === 'object'
      ? (raw.pWinnerNudge as Record<string, unknown>)
      : {}
  const tiersRaw =
    raw.tiers && typeof raw.tiers === 'object'
      ? (raw.tiers as Record<string, unknown>)
      : {}

  const tpMin = readFinite(clampsRaw.tpMin) ?? defaults.clamps.tpMin
  const tpMax = readFinite(clampsRaw.tpMax) ?? defaults.clamps.tpMax
  const slMin = readFinite(clampsRaw.slMin) ?? defaults.clamps.slMin
  const slMax = readFinite(clampsRaw.slMax) ?? defaults.clamps.slMax

  return {
    version: 1,
    clamps: {
      tpMin: Math.min(tpMin, tpMax),
      tpMax: Math.max(tpMin, tpMax),
      slMin: Math.min(slMin, slMax),
      slMax: Math.max(slMin, slMax),
    },
    moonScorePromote: {
      tier3: readFinite(moonRaw.tier3) ?? defaults.moonScorePromote.tier3,
      tier4: readFinite(moonRaw.tier4) ?? defaults.moonScorePromote.tier4,
    },
    pWinnerNudge: {
      min: readFinite(nudgeRaw.min) ?? defaults.pWinnerNudge.min,
      tpBonus: readFinite(nudgeRaw.tpBonus) ?? defaults.pWinnerNudge.tpBonus,
      minTier: readFinite(nudgeRaw.minTier) ?? defaults.pWinnerNudge.minTier,
    },
    tiers: {
      1: mergeTierRule(
        defaults.tiers[1],
        tiersRaw['1'] as Record<string, unknown> | undefined,
      ),
      2: mergeTierRule(
        defaults.tiers[2],
        tiersRaw['2'] as Record<string, unknown> | undefined,
      ),
      3: mergeTierRule(
        defaults.tiers[3],
        tiersRaw['3'] as Record<string, unknown> | undefined,
      ),
      4: mergeTierRule(
        defaults.tiers[4],
        tiersRaw['4'] as Record<string, unknown> | undefined,
      ),
    },
    exitModeOverride: parseExitModeOverride(raw.exitModeOverride),
  }
}

export function applyTierRule(
  baseTp: number,
  baseSl: number,
  baseHold: number,
  rule: TierExitRule,
): { takeProfitPct: number; stopLossPct: number; maxHoldHours: number } {
  let takeProfitPct = baseTp
  let stopLossPct = baseSl
  let maxHoldHours = baseHold

  if (rule.takeProfitPct != null) takeProfitPct = rule.takeProfitPct
  if (rule.takeProfitMin != null) takeProfitPct = Math.max(takeProfitPct, rule.takeProfitMin)
  if (rule.takeProfitMax != null) takeProfitPct = Math.min(takeProfitPct, rule.takeProfitMax)

  if (rule.stopLossPct != null) stopLossPct = rule.stopLossPct
  if (rule.stopLossTighter != null) {
    stopLossPct = Math.max(stopLossPct, rule.stopLossTighter)
  }
  if (rule.stopLossWider != null) {
    stopLossPct = Math.min(stopLossPct, rule.stopLossWider)
  }

  if (rule.maxHoldHoursDelta != null) {
    maxHoldHours = baseHold + rule.maxHoldHoursDelta
  }
  if (rule.maxHoldHoursCap != null) {
    maxHoldHours = Math.min(maxHoldHours, rule.maxHoldHoursCap)
  }

  return { takeProfitPct, stopLossPct, maxHoldHours }
}

let cachedConfig: PotentialExitOverlayConfig | null = null
let cacheLoadedAt = 0
const CACHE_TTL_MS = 30_000

export function invalidatePotentialExitOverlayConfigCache(): void {
  cachedConfig = null
  cacheLoadedAt = 0
}

export async function loadPotentialExitOverlayConfig(): Promise<PotentialExitOverlayConfig> {
  const now = Date.now()
  if (cachedConfig && now - cacheLoadedAt < CACHE_TTL_MS) {
    return cachedConfig
  }

  try {
    const { loadStrategyDefinitionById } = await import('./db')
    const row = await loadStrategyDefinitionById(ML2_EXIT_OVERLAY_STRATEGY_ID)
    if (row?.config && typeof row.config === 'object') {
      cachedConfig = parsePotentialExitOverlayConfig(
        row.config as Record<string, unknown>,
      )
      cacheLoadedAt = now
      return cachedConfig
    }
  } catch {
    /* fall through to defaults */
  }

  cachedConfig = getDefaultPotentialExitOverlayConfig()
  cacheLoadedAt = now
  return cachedConfig
}

export async function savePotentialExitOverlayConfig(
  config: PotentialExitOverlayConfig,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = parsePotentialExitOverlayConfig(
    config as unknown as Record<string, unknown>,
  )
  const { upsertStrategyDefinition } = await import('./db')
  const result = await upsertStrategyDefinition({
    id: ML2_EXIT_OVERLAY_STRATEGY_ID,
    domain: 'mcap_tracker',
    name: 'ML2 Exit Overlay',
    description:
      'Potential → TP/SL overlay rules + optional exitModeOverride (sim only)',
    config: parsed as unknown as Record<string, unknown>,
    is_active: true,
    execution_mode: 'sim_only',
  })
  if (result.ok) invalidatePotentialExitOverlayConfigCache()
  return result
}

/** Preview helper for admin UI. */
export function previewOverlayForBase(
  config: PotentialExitOverlayConfig,
  base: { stopLossPct: number; takeProfitPct: number; maxHoldHours: number },
  tier: 1 | 2 | 3 | 4,
): { stopLossPct: number; takeProfitPct: number; maxHoldHours: number } {
  const rule = config.tiers[tier]
  const applied = applyTierRule(
    base.takeProfitPct,
    base.stopLossPct,
    base.maxHoldHours,
    rule,
  )
  return {
    takeProfitPct: Math.min(
      config.clamps.tpMax,
      Math.max(config.clamps.tpMin, applied.takeProfitPct),
    ),
    stopLossPct: Math.min(
      config.clamps.slMax,
      Math.max(config.clamps.slMin, applied.stopLossPct),
    ),
    maxHoldHours: applied.maxHoldHours,
  }
}
