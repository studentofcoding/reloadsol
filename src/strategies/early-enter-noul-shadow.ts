/**
 * Jev Noul soft-gate shadow beside Early Enter (SPEC-jev-soft-gate-shadow-v1).
 * Pure helpers — band classify, arm fog pick, flags. No paper / sim-open.
 *
 * Soft-fail (mid / api_miss) is never described as "low confidence" —
 * Noul has no confidence field.
 */

import type { AppNetwork } from '@/utils/app-network'
import {
  getEarlyEnterMlMin,
  isEarlyEnterMlSoftGateEnabled,
  passesEarlyEnterMlSoftGate,
} from './signals-early-ml-gate'

export const DEFAULT_NOUL_NO = 0.2
export const DEFAULT_NOUL_YES = 0.8
export const NOUL_GROWTH_ARM_CUT = 80

export type NoulShadowBand =
  | 'suppress'
  | 'mid'
  | 'keep'
  | 'skipped_null'
  | 'api_miss'

export type NoulShadowDecision = 'keep' | 'suppress' | 'follow_spec'
export type NoulSpecDecision = 'keep' | 'suppress'

const NOUL_SHADOW_BANDS: ReadonlySet<string> = new Set([
  'suppress',
  'mid',
  'keep',
  'skipped_null',
  'api_miss',
])

export function isNoulShadowBand(value: string): value is NoulShadowBand {
  return NOUL_SHADOW_BANDS.has(value)
}

/** Operator-facing filter reason (band skipped_null → null_ml). */
export type NoulFilterReason =
  | 'null_ml'
  | 'mid'
  | 'suppress'
  | 'keep'
  | 'api_miss'

export function filterReasonFromBand(band: NoulShadowBand): NoulFilterReason {
  if (band === 'skipped_null') return 'null_ml'
  return band
}

/** SPEC §7 / #54 flip bars (shadow → soft-active readiness). */
export const FLIP_N_MIN = 500
export const FLIP_AGREEMENT_MIN = 0.85
export const FLIP_MID_MAX = 0.2

export type FlipArmFamily = 'first_seen' | 'at_80'

export function flipArmFamilyFromStrategyKey(
  strategyKey: string,
): FlipArmFamily | null {
  if (strategyKey.includes('first_seen')) return 'first_seen'
  if (strategyKey.includes('at_80')) return 'at_80'
  return null
}

export const FIRST_SEEN_STRATEGY_KEYS = [
  'mcap_enter_first_seen',
  'mcap_enter_first_seen_rh',
] as const

export const AT_80_STRATEGY_KEYS = [
  'mcap_enter_at_80',
  'mcap_enter_at_80_rh',
] as const

export function strategyKeysForArmFamily(
  arm: FlipArmFamily,
): readonly string[] {
  return arm === 'first_seen' ? FIRST_SEEN_STRATEGY_KEYS : AT_80_STRATEGY_KEYS
}

export type FlipBarCheck = {
  nOk: boolean
  agreementOk: boolean
  midOk: boolean
  /** miss% at or under the kill. Separate from A and from suppress disagreement. */
  missOk: boolean
  /** N, A, M, and miss% all clear. Does not turn soft-active on. */
  ready: boolean
}

/**
 * A and M must already exclude api_miss.
 * Agreement is keep/suppress only. Mid denominator is non-miss rows.
 * miss% is api_miss / all rows — its own #54 kill, not a disagreement rate.
 */
export function noulFlipSampleRates(opts: {
  total: number
  midBand: number
  apiMiss: number
  agreementEligible: number
  agreementMatches: number
}): {
  agreementRate: number | null
  midBandRate: number | null
  apiMissRate: number | null
  midDenom: number
} {
  const midDenom = Math.max(0, opts.total - opts.apiMiss)
  return {
    agreementRate:
      opts.agreementEligible > 0
        ? opts.agreementMatches / opts.agreementEligible
        : null,
    midBandRate: midDenom > 0 ? opts.midBand / midDenom : null,
    apiMissRate: opts.total > 0 ? opts.apiMiss / opts.total : null,
    midDenom,
  }
}

export function evaluateFlipBars(opts: {
  total: number
  agreementRate: number | null
  midBandRate: number | null
  /** When omitted, miss is not applied (callers that have a rate must pass it). */
  apiMissRate?: number | null
  apiMissMax?: number
}): FlipBarCheck {
  const nOk = opts.total >= FLIP_N_MIN
  const agreementOk =
    opts.agreementRate != null &&
    Number.isFinite(opts.agreementRate) &&
    opts.agreementRate >= FLIP_AGREEMENT_MIN
  const midOk =
    opts.midBandRate != null &&
    Number.isFinite(opts.midBandRate) &&
    opts.midBandRate <= FLIP_MID_MAX
  const missMax = opts.apiMissMax ?? DEFAULT_API_MISS_KILL_RATE
  const missOk =
    opts.apiMissRate == null ||
    !Number.isFinite(opts.apiMissRate) ||
    opts.apiMissRate <= missMax
  return {
    nOk,
    agreementOk,
    midOk,
    missOk,
    ready: nOk && agreementOk && midOk && missOk,
  }
}

/**
 * A 24h miss spike blocks flip even when the all-time miss% is still under the kill.
 * Disagreement among keep/suppress is not applied here.
 */
export function flipBarsWithMissKill(
  bars: FlipBarCheck,
  apiMissSpike: boolean,
): FlipBarCheck {
  const missOk = bars.missOk && !apiMissSpike
  return {
    ...bars,
    missOk,
    ready: bars.nOk && bars.agreementOk && bars.midOk && missOk,
  }
}

/**
 * Population variance at or under this is a constant closed-loop score.
 * The live shadow sample’s 0.3146–0.3207 cluster is ~1e-6.
 */
export const VACUOUS_CL_SCORE_VARIANCE_MAX = 1e-6

export function closedLoopPopulationVariance(
  n: number,
  sum: number,
  sumSq: number,
): number | null {
  if (!Number.isFinite(n) || n < 2) return null
  if (!Number.isFinite(sum) || !Number.isFinite(sumSq)) return null
  const mean = sum / n
  const variance = sumSq / n - mean * mean
  if (!Number.isFinite(variance)) return null
  return Math.max(0, variance)
}

/**
 * 100% SPEC/Noul agreement is vacuous when every called row is suppress
 * (keep band count is 0) or closed-loop scores do not vary.
 * An empty sample is not vacuous.
 */
export function isVacuousFlipAgreement(opts: {
  keepCount: number
  clScoreN: number
  clScoreVariance: number | null
}): boolean {
  if (opts.clScoreN <= 0 && opts.keepCount <= 0) return false
  const noKeep = opts.keepCount <= 0
  const flatScores =
    opts.clScoreN >= 2 &&
    opts.clScoreVariance != null &&
    Number.isFinite(opts.clScoreVariance) &&
    opts.clScoreVariance <= VACUOUS_CL_SCORE_VARIANCE_MAX
  return noKeep || flatScores
}

/** Vacuous agreement holds flip-ready off. It does not turn soft-active on. */
export function applyVacuousFlipAgreement(
  bars: FlipBarCheck,
  vacuous: boolean,
): FlipBarCheck {
  if (!vacuous) return bars
  return { ...bars, ready: false }
}

/**
 * #54 kill switches. SPEC left the exact spike formula as ops fog; these
 * defaults are the tracked thresholds (env-tunable). A spike holds soft-active
 * off. It never turns soft-active on. Paper is untouched.
 *
 * miss% = api_miss / all rows. It is not suppress-vs-SPEC disagreement
 * (that lives only in the agreement bar, which already excludes api_miss).
 * miss% above the max blocks flip. It never turns soft-active on.
 * All-time or last-24h can trip once that window has KILL_SWITCH_MIN_N rows.
 */
export const DEFAULT_API_MISS_KILL_RATE = 0.1
export const DEFAULT_DISAGREEMENT_KILL_RATE = 0.15
export const KILL_SWITCH_MIN_N = 20

export function getApiMissKillRate(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return parseFiniteEnv(
    env.EARLY_ENTER_NOUL_API_MISS_KILL_RATE,
    DEFAULT_API_MISS_KILL_RATE,
  )
}

export function getDisagreementKillRate(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return parseFiniteEnv(
    env.EARLY_ENTER_NOUL_DISAGREEMENT_KILL_RATE,
    DEFAULT_DISAGREEMENT_KILL_RATE,
  )
}

export type KillSwitchCheck = {
  /** All-time rates (display). Spike flags include the 24h window when merged. */
  apiMissRate: number | null
  disagreementRate: number | null
  apiMissSpike: boolean
  disagreementSpike: boolean
  /**
   * miss% kill only. Disagreement among keep/suppress is the A bar, not this flag.
   * Holds flip off. Never enables soft-active.
   */
  tripped: boolean
}

export function evaluateKillSwitchWindow(opts: {
  total: number
  apiMiss: number
  agreementEligible: number
  agreementMatches: number
  apiMissMax?: number
  disagreementMax?: number
  minN?: number
}): KillSwitchCheck {
  const apiMissMax = opts.apiMissMax ?? DEFAULT_API_MISS_KILL_RATE
  const disagreementMax = opts.disagreementMax ?? DEFAULT_DISAGREEMENT_KILL_RATE
  const minN = opts.minN ?? KILL_SWITCH_MIN_N
  const apiMissRate = opts.total > 0 ? opts.apiMiss / opts.total : null
  const disagreement = Math.max(0, opts.agreementEligible - opts.agreementMatches)
  const disagreementRate =
    opts.agreementEligible > 0 ? disagreement / opts.agreementEligible : null
  const apiMissSpike =
    opts.total >= minN && apiMissRate != null && apiMissRate > apiMissMax
  const disagreementSpike =
    opts.agreementEligible >= minN &&
    disagreementRate != null &&
    disagreementRate > disagreementMax
  return {
    apiMissRate,
    disagreementRate,
    apiMissSpike,
    disagreementSpike,
    tripped: apiMissSpike,
  }
}

/** Spike if either the all-time sample or the recent window trips. Rates shown are all-time. */
export function mergeKillSwitches(
  allTime: KillSwitchCheck,
  recent: KillSwitchCheck,
): KillSwitchCheck {
  return {
    apiMissRate: allTime.apiMissRate,
    disagreementRate: allTime.disagreementRate,
    apiMissSpike: allTime.apiMissSpike || recent.apiMissSpike,
    disagreementSpike: allTime.disagreementSpike || recent.disagreementSpike,
    tripped: allTime.tripped || recent.tripped,
  }
}

export function emptyKillSwitch(): KillSwitchCheck {
  return evaluateKillSwitchWindow({
    total: 0,
    apiMiss: 0,
    agreementEligible: 0,
    agreementMatches: 0,
  })
}

export type EarlyEnterNoulStrategyKey =
  | 'mcap_enter_first_seen'
  | 'mcap_enter_at_80'
  | 'mcap_enter_first_seen_rh'
  | 'mcap_enter_at_80_rh'

export const EARLY_ENTER_NOUL_STRATEGY_KEYS = [
  'mcap_enter_first_seen',
  'mcap_enter_at_80',
  'mcap_enter_first_seen_rh',
  'mcap_enter_at_80_rh',
] as const

export type EarlyEnterNoulState = {
  token_address: string
  chain: AppNetwork
  cl_ml_score: number
  cl_model_version: string
  EARLY_ENTER_ML_MIN: number
  EARLY_ENTER_ML_SOFT_GATE: boolean
  spec_would_pass: boolean
  symbol?: string
}

function parseOnOffEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  return fallback
}

function parseFiniteEnv(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** Default on — write shadow rows + call Noul when arm-scoped. */
export function isEarlyEnterNoulShadowEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseOnOffEnv(env.EARLY_ENTER_NOUL_SHADOW, true)
}

/**
 * Soft-active: Noul keep/suppress may drive toast. Default OFF.
 * Kill switch env forces off (ops spike → shadow-only). Does NOT auto-flip
 * from N/agreement in v1 — human flag only.
 */
export function isEarlyEnterNoulSoftActiveEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (parseOnOffEnv(env.EARLY_ENTER_NOUL_KILL_SWITCH, false)) return false
  return parseOnOffEnv(env.EARLY_ENTER_NOUL_SOFT_ACTIVE, false)
}

export function getEarlyEnterNoulNo(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return parseFiniteEnv(env.EARLY_ENTER_NOUL_NO, DEFAULT_NOUL_NO)
}

export function getEarlyEnterNoulYes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return parseFiniteEnv(env.EARLY_ENTER_NOUL_YES, DEFAULT_NOUL_YES)
}

export function classifyNoulBand(
  noul: number | null,
  opts?: { no?: number; yes?: number; apiMiss?: boolean },
): NoulShadowBand {
  if (opts?.apiMiss) return 'api_miss'
  if (noul == null || !Number.isFinite(noul)) return 'api_miss'
  const no = opts?.no ?? DEFAULT_NOUL_NO
  const yes = opts?.yes ?? DEFAULT_NOUL_YES
  if (noul <= no) return 'suppress'
  if (noul >= yes) return 'keep'
  return 'mid'
}

export function decisionShadowFromBand(
  band: NoulShadowBand,
): NoulShadowDecision {
  if (band === 'keep') return 'keep'
  if (band === 'suppress') return 'suppress'
  return 'follow_spec'
}

export function decisionSpecFromPass(specWouldPass: boolean): NoulSpecDecision {
  return specWouldPass ? 'keep' : 'suppress'
}

/**
 * Fog arm pick: growth < 80 → first_seen*; growth ≥ 80 (and < 100 Stage-1) → at_80*.
 * Returns null when that strategy is not in the active set.
 */
export function resolveEarlyEnterNoulStrategyKey(opts: {
  chain: AppNetwork
  growthPercent: number
  activeStrategyKeys: Iterable<string>
}): EarlyEnterNoulStrategyKey | null {
  const active = opts.activeStrategyKeys instanceof Set
    ? opts.activeStrategyKeys
    : new Set(opts.activeStrategyKeys)
  const rh = opts.chain === 'robinhood'
  const key: EarlyEnterNoulStrategyKey =
    opts.growthPercent < NOUL_GROWTH_ARM_CUT
      ? rh
        ? 'mcap_enter_first_seen_rh'
        : 'mcap_enter_first_seen'
      : rh
        ? 'mcap_enter_at_80_rh'
        : 'mcap_enter_at_80'
  return active.has(key) ? key : null
}

export function buildEarlyEnterNoulState(opts: {
  tokenAddress: string
  chain: AppNetwork
  clMlScore: number
  clModelVersion: string | null | undefined
  specWouldPass: boolean
  symbol?: string | null
  mlMin?: number
  mlSoftGateEnabled?: boolean
}): EarlyEnterNoulState {
  return {
    token_address: opts.tokenAddress,
    chain: opts.chain,
    cl_ml_score: opts.clMlScore,
    cl_model_version: opts.clModelVersion || 'cl-unknown',
    EARLY_ENTER_ML_MIN: opts.mlMin ?? getEarlyEnterMlMin(),
    EARLY_ENTER_ML_SOFT_GATE:
      opts.mlSoftGateEnabled ?? isEarlyEnterMlSoftGateEnabled(),
    spec_would_pass: opts.specWouldPass,
    ...(opts.symbol ? { symbol: opts.symbol } : {}),
  }
}

/**
 * Whether toast/Telegram should emit given SPEC pass + optional Noul soft-active.
 * Soft-fail bands (mid / api_miss / skipped_null) always fall back to SPEC.
 * Paper never calls this path.
 */
export function shouldEmitWithNoulSoftActive(opts: {
  specWouldPass: boolean
  softActive: boolean
  band: NoulShadowBand | null
}): boolean {
  if (!opts.softActive || opts.band == null) return opts.specWouldPass
  if (opts.band === 'keep') return true
  if (opts.band === 'suppress') return false
  // mid | api_miss | skipped_null → follow SPEC
  return opts.specWouldPass
}

export function computeSpecWouldPass(
  mlScore: number | null | undefined,
  opts?: { min?: number; enabled?: boolean },
): boolean {
  return passesEarlyEnterMlSoftGate(mlScore, opts)
}
