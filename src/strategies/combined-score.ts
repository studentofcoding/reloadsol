/**
 * Principal + adjuster combined score v1 (buy_bulk-local).
 *
 * principals (mcap first_seen / at_80) + adjusters (signals/gmgn/social/trending)
 * + Jaccard meanPairwiseOverlapCorr + brain OHLC rug patterns
 *   → combined ∈ [0, 1]
 *
 * Default weights live in COMBINED_SCORE_WEIGHTS (0.55 / 0.20 / 0.15 / 0.10).
 * Operators can override them from /dev/strategies; the score reader loads
 * the live row and renormalizes. Rug trip is a score penalty only — it does
 * not block principal opens.
 */
import { meanPairwiseOverlapCorr } from '@/strategies/token-map-strategy-chart-paint'
import type { TokenChartOutcomeSegment } from '@/strategies/token-map-chart'
import type { StrategyPresence } from '@/strategies/token-locate'
import type { TokenMapDomain } from '@/strategies/token-map-types'
import type { BrainOhlcPatternSummary } from '@/utils/market-brain'

export const COMBINED_SCORE_WEIGHTS = {
  principal: 0.55,
  adjusterPresence: 0.2,
  jaccard: 0.15,
  ohlcPattern: 0.1,
} as const

/** Applied only when a live mlScore exists and the operator did not set `ml`. */
export const DEFAULT_ML_WEIGHT = 0.1

export const PRINCIPAL_STRATEGY_IDS = [
  'mcap_enter_first_seen',
  'mcap_enter_at_80',
] as const

export type PrincipalStrategyId = (typeof PRINCIPAL_STRATEGY_IDS)[number]

export const ADJUSTER_DOMAINS = [
  'signals',
  'gmgn',
  'social',
  'trending_bot',
] as const

export type AdjusterDomain = (typeof ADJUSTER_DOMAINS)[number]

/** Domains that feed Jaccard (principals map to mcap_tracker). No dlmm. */
export const COMBINED_SCORE_DOMAINS: TokenMapDomain[] = [
  'mcap_tracker',
  'signals',
  'gmgn',
  'social',
  'trending_bot',
]

export const DUMP_PCT_SCALE = 0.4
export const AVG_UPPER_WICK_SCALE = 0.6
export const OHLC_PATTERN_FAIL_SOFT = 0.5

export type CombinedScoreChain = 'sol' | 'robinhood'

export type CombinedScoreWeights = {
  principal: number
  adjusterPresence: number
  jaccard: number
  ohlcPattern: number
  /** Optional 5th key. Omitted in v1 defaults; renormalizes when present. */
  ml?: number
}

export type CombinedScoreParts = {
  principalScore: number
  adjusterPresenceScore: number
  jaccardScore: number | null
  ohlcPatternScore: number
}

export type CombinedScorePrincipal = {
  strategyId: string
  present: boolean
  status?: string
}

export type CombinedScoreAdjuster = {
  domain: string
  present: boolean
}

export type CombinedScoreResponse = {
  success: true
  mint: string
  chain: CombinedScoreChain
  hours: number
  combined: number
  weights: CombinedScoreWeights
  parts: CombinedScoreParts
  principals: CombinedScorePrincipal[]
  adjusters: CombinedScoreAdjuster[]
  ohlcSource?: string
  rugTrip?: boolean
  mlScore?: number | null
  modelVersion?: string | null
  generatedAt: string
}

export type CombinedScoreLocateInput = {
  strategyPresence: StrategyPresence[]
  locations: {
    trending: { present: boolean; status?: string } | null
    mcap: { present: boolean } | null
    signals: { present: boolean } | null
    social: { present: boolean } | null
  }
}

export type CombinedScoreAssembleInput = {
  mint: string
  chain: CombinedScoreChain
  hours: number
  nowMs?: number
  generatedAt?: string
  locate: CombinedScoreLocateInput | null
  outcomes: TokenChartOutcomeSegment[]
  ohlcPatterns: BrainOhlcPatternSummary | null
  ohlcFailed?: boolean
  ohlcSource?: string
  /** Live operator weights; defaults when omitted. */
  weights?: CombinedScoreWeights
  mlScore?: number | null
  modelVersion?: string | null
}

export const COMBINED_SCORE_CORE_WEIGHT_KEYS = [
  'principal',
  'adjusterPresence',
  'jaccard',
  'ohlcPattern',
] as const

export const COMBINED_SCORE_WEIGHT_KEYS = [
  ...COMBINED_SCORE_CORE_WEIGHT_KEYS,
  'ml',
] as const

export type CombinedScoreCoreWeightKey = (typeof COMBINED_SCORE_CORE_WEIGHT_KEYS)[number]
export type CombinedScoreWeightKey = (typeof COMBINED_SCORE_WEIGHT_KEYS)[number]

const WEIGHT_ALIASES: Record<CombinedScoreWeightKey, string[]> = {
  principal: ['principal'],
  adjusterPresence: ['adjusterPresence', 'adjuster_presence'],
  jaccard: ['jaccard'],
  ohlcPattern: ['ohlcPattern', 'ohlc_pattern'],
  ml: ['ml', 'mlPattern', 'ml_pattern'],
}

const WEIGHT_SUM_EPS = 1e-9

export type CombinedScoreWeightsValidation =
  | {
      ok: true
      weights: CombinedScoreWeights
      renormalized: boolean
      sumBefore: number
    }
  | { ok: false; error: string }

function readWeightNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

export function readCombinedScoreWeight(
  raw: Record<string, unknown> | null | undefined,
  key: CombinedScoreWeightKey,
): number | null {
  if (!raw) return null
  for (const alias of WEIGHT_ALIASES[key]) {
    const n = readWeightNumber(raw[alias])
    if (n != null) return n
  }
  return null
}

/**
 * Validate operator weights.
 *
 * Rule: each weight must be a finite number ≥ 0 and the sum must be > 0.
 * Saved / applied weights are **renormalized** so they sum to 1 (55/20/15/10
 * and 0.55/0.20/0.15/0.10 both work). Reject negatives, NaN, and an all-zero set.
 */
export function validateCombinedScoreWeights(
  raw: unknown,
): CombinedScoreWeightsValidation {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'weights must be an object' }
  }
  const obj = raw as Record<string, unknown>
  const parsed = {} as CombinedScoreWeights
  for (const key of COMBINED_SCORE_CORE_WEIGHT_KEYS) {
    const n = readCombinedScoreWeight(obj, key)
    if (n == null) {
      return { ok: false, error: `${key} must be a finite number ≥ 0` }
    }
    if (n < 0) {
      return { ok: false, error: `${key} must be ≥ 0` }
    }
    parsed[key] = n
  }
  const mlRaw = readCombinedScoreWeight(obj, 'ml')
  if (mlRaw != null) {
    if (mlRaw < 0) return { ok: false, error: 'ml must be ≥ 0' }
    parsed.ml = mlRaw
  }
  const sumBefore =
    parsed.principal +
    parsed.adjusterPresence +
    parsed.jaccard +
    parsed.ohlcPattern +
    (parsed.ml ?? 0)
  if (!(sumBefore > 0)) {
    return { ok: false, error: 'weights must sum to more than 0' }
  }
  const renormalized = Math.abs(sumBefore - 1) > WEIGHT_SUM_EPS
  const weights: CombinedScoreWeights = {
    principal: parsed.principal / sumBefore,
    adjusterPresence: parsed.adjusterPresence / sumBefore,
    jaccard: parsed.jaccard / sumBefore,
    ohlcPattern: parsed.ohlcPattern / sumBefore,
    ...(parsed.ml != null ? { ml: parsed.ml / sumBefore } : {}),
  }
  return { ok: true, weights, renormalized, sumBefore }
}

/**
 * When mlScore is missing, drop `ml` and renormalize the four core keys so
 * combined is unchanged. When mlScore is present and `ml` was omitted, apply
 * DEFAULT_ML_WEIGHT and renormalize. Explicit `ml: 0` keeps the four-key formula.
 */
export function resolveCombinedScoreWeights(
  weights: CombinedScoreWeights,
  mlScore: number | null | undefined,
): CombinedScoreWeights {
  const hasScore = mlScore != null && Number.isFinite(mlScore)
  const core = {
    principal: weights.principal,
    adjusterPresence: weights.adjusterPresence,
    jaccard: weights.jaccard,
    ohlcPattern: weights.ohlcPattern,
  }
  if (!hasScore) {
    return parseCombinedScoreWeights(core)
  }
  const ml =
    weights.ml != null && Number.isFinite(weights.ml) ? weights.ml : DEFAULT_ML_WEIGHT
  if (ml <= 0) return parseCombinedScoreWeights(core)
  return parseCombinedScoreWeights({ ...core, ml })
}

/** Fail-soft parse for scoring: invalid / missing → v1 defaults. */
export function parseCombinedScoreWeights(raw: unknown): CombinedScoreWeights {
  const validated = validateCombinedScoreWeights(raw)
  return validated.ok ? validated.weights : { ...COMBINED_SCORE_WEIGHTS }
}

export function defaultCombinedScoreWeights(): CombinedScoreWeights {
  return { ...COMBINED_SCORE_WEIGHTS }
}

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  if (n <= 0) return 0
  if (n >= 1) return 1
  return n
}

export function roundScore(n: number): number {
  return Math.round(clamp01(n) * 1e6) / 1e6
}

export function canonicalPrincipalId(strategyId: string): PrincipalStrategyId | null {
  if (
    strategyId === 'mcap_enter_first_seen' ||
    strategyId === 'mcap_enter_first_seen_rh'
  ) {
    return 'mcap_enter_first_seen'
  }
  if (strategyId === 'mcap_enter_at_80' || strategyId === 'mcap_enter_at_80_rh') {
    return 'mcap_enter_at_80'
  }
  return null
}

function isAdjusterDomain(domain: string): domain is AdjusterDomain {
  return (ADJUSTER_DOMAINS as readonly string[]).includes(domain)
}

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

function statusNorm(status: string | null | undefined): string {
  return (status ?? '').trim().toLowerCase()
}

export function isOpenOutcome(outcome: {
  status?: string | null
  exitAt?: string | null
}): boolean {
  const status = statusNorm(outcome.status)
  if (status === 'won' || status === 'lost' || status === 'closed' || status === 'skipped') {
    return false
  }
  if (status === 'open' || status === 'tracking') return true
  return !outcome.exitAt
}

export function isWonOutcome(outcome: { status?: string | null }): boolean {
  return statusNorm(outcome.status) === 'won'
}

function windowOverlaps(
  outcome: { entryAt?: string | null; exitAt?: string | null },
  nowMs: number,
): boolean {
  const start = parseTime(outcome.entryAt)
  if (start == null || start > nowMs) return false
  const end = parseTime(outcome.exitAt) ?? nowMs
  return nowMs <= end
}

function enteredWithin(
  outcome: { entryAt?: string | null },
  windowStartMs: number,
  nowMs: number,
): boolean {
  const start = parseTime(outcome.entryAt)
  if (start == null) return false
  return start >= windowStartMs && start <= nowMs
}

function closedInWindow(
  outcome: { exitAt?: string | null },
  windowStartMs: number,
  nowMs: number,
): boolean {
  const exit = parseTime(outcome.exitAt)
  if (exit == null) return false
  return exit >= windowStartMs && exit <= nowMs
}

export function hasMcapPrincipalPresence(locate: CombinedScoreLocateInput | null): boolean {
  if (!locate) return false
  if (locate.locations.mcap?.present) return true
  return locate.strategyPresence.some(
    (row) =>
      row.domain === 'mcap_tracker' || canonicalPrincipalId(row.strategyId ?? '') != null,
  )
}

export function presentAdjusterDomains(
  locate: CombinedScoreLocateInput | null,
  outcomes: TokenChartOutcomeSegment[],
): Set<AdjusterDomain> {
  const present = new Set<AdjusterDomain>()
  if (locate?.locations.signals?.present) present.add('signals')
  if (locate?.locations.social?.present) present.add('social')
  if (locate?.locations.trending?.present) present.add('trending_bot')
  for (const row of locate?.strategyPresence ?? []) {
    if (isAdjusterDomain(row.domain)) present.add(row.domain)
  }
  for (const outcome of outcomes) {
    if (isAdjusterDomain(outcome.domain)) present.add(outcome.domain)
  }
  return present
}

export function principalOutcomes(
  outcomes: TokenChartOutcomeSegment[],
  strategyId?: PrincipalStrategyId,
): TokenChartOutcomeSegment[] {
  return outcomes.filter((outcome) => {
    const id = canonicalPrincipalId(outcome.strategyId)
    if (id == null) return false
    return strategyId == null || id === strategyId
  })
}

/**
 * 1.0 open/won overlapping now (or last-window open)
 * 0.6 any closed outcome in window with pnl ≥ 0
 * 0.3 presence only (mcap tracking / strategy_presence)
 * 0.0 otherwise
 */
export function scorePrincipal(params: {
  outcomes: TokenChartOutcomeSegment[]
  presence: boolean
  nowMs?: number
  hours?: number
}): number {
  const nowMs = params.nowMs ?? Date.now()
  const hours = params.hours ?? 24
  const windowStartMs = nowMs - hours * 60 * 60 * 1000
  const rows = principalOutcomes(params.outcomes)

  for (const row of rows) {
    const open = isOpenOutcome(row)
    const won = isWonOutcome(row)
    if (!open && !won) continue
    if (windowOverlaps(row, nowMs)) return 1
    if (open && enteredWithin(row, windowStartMs, nowMs)) return 1
  }

  for (const row of rows) {
    if (isOpenOutcome(row)) continue
    if (!closedInWindow(row, windowStartMs, nowMs) && !windowOverlaps(row, nowMs)) {
      continue
    }
    const pnl = row.pnlPct
    if (typeof pnl === 'number' && Number.isFinite(pnl) && pnl >= 0) return 0.6
  }

  return params.presence ? 0.3 : 0
}

export function scoreAdjusterPresence(present: ReadonlySet<string>): number {
  let n = 0
  for (const domain of ADJUSTER_DOMAINS) {
    if (present.has(domain)) n += 1
  }
  return n / ADJUSTER_DOMAINS.length
}

/** Null Jaccard (fewer than 2 overlapping domains) is 0 in the formula. */
export function jaccardScoreForFormula(corr: number | null): number {
  return corr == null || !Number.isFinite(corr) ? 0 : clamp01(corr)
}

export function scoreOhlcPattern(
  patterns: BrainOhlcPatternSummary | null | undefined,
  opts?: { failed?: boolean },
): number {
  if (opts?.failed || patterns == null) return OHLC_PATTERN_FAIL_SOFT
  if (patterns.rug.trip === true) return 0

  const features = patterns.rug.features
  const harsh: number[] = []
  if (features.dumpPct != null && Number.isFinite(features.dumpPct)) {
    harsh.push(features.dumpPct / DUMP_PCT_SCALE)
  }
  if (features.avgUpperWick != null && Number.isFinite(features.avgUpperWick)) {
    harsh.push(features.avgUpperWick / AVG_UPPER_WICK_SCALE)
  }
  if (features.volDeathRatio != null && Number.isFinite(features.volDeathRatio)) {
    harsh.push(1 - features.volDeathRatio)
  }
  const maxHarsh = harsh.length > 0 ? Math.max(...harsh) : 0
  return clamp01(1 - clamp01(maxHarsh))
}

export function combineParts(
  parts: CombinedScoreParts,
  weights: CombinedScoreWeights = COMBINED_SCORE_WEIGHTS,
  mlScore?: number | null,
): number {
  const mlW = weights.ml
  const mlTerm =
    mlW != null && mlW > 0 && mlScore != null && Number.isFinite(mlScore)
      ? mlW * clamp01(mlScore)
      : 0
  return roundScore(
    weights.principal * parts.principalScore +
      weights.adjusterPresence * parts.adjusterPresenceScore +
      weights.jaccard * jaccardScoreForFormula(parts.jaccardScore) +
      weights.ohlcPattern * parts.ohlcPatternScore +
      mlTerm,
  )
}

function principalRow(
  strategyId: PrincipalStrategyId,
  locate: CombinedScoreLocateInput | null,
  outcomes: TokenChartOutcomeSegment[],
  mcapPresent: boolean,
  nowMs: number,
): CombinedScorePrincipal {
  const rows = principalOutcomes(outcomes, strategyId)
  const presenceRows = (locate?.strategyPresence ?? []).filter(
    (row) => canonicalPrincipalId(row.strategyId ?? '') === strategyId,
  )
  const present = mcapPresent || rows.length > 0 || presenceRows.length > 0

  const open = rows.find((row) => isOpenOutcome(row) && windowOverlaps(row, nowMs))
  const won = rows.find((row) => isWonOutcome(row) && windowOverlaps(row, nowMs))
  const latest = rows[0]
  const status =
    open?.status ?? won?.status ?? latest?.status ?? presenceRows[0]?.status

  return status ? { strategyId, present, status } : { strategyId, present }
}

export function assembleCombinedScore(
  input: CombinedScoreAssembleInput,
): CombinedScoreResponse {
  const nowMs = input.nowMs ?? Date.now()
  const hours = input.hours
  const mcapPresent = hasMcapPrincipalPresence(input.locate)
  const adjusterPresent = presentAdjusterDomains(input.locate, input.outcomes)
  const enabled = new Set<TokenMapDomain>(COMBINED_SCORE_DOMAINS)
  const nowSec = Math.floor(nowMs / 1000)
  const jaccard = meanPairwiseOverlapCorr(input.outcomes, enabled, nowSec)

  const parts: CombinedScoreParts = {
    principalScore: scorePrincipal({
      outcomes: input.outcomes,
      presence: mcapPresent,
      nowMs,
      hours,
    }),
    adjusterPresenceScore: scoreAdjusterPresence(adjusterPresent),
    jaccardScore: jaccard,
    ohlcPatternScore: scoreOhlcPattern(input.ohlcPatterns, {
      failed: input.ohlcFailed,
    }),
  }

  const principals = PRINCIPAL_STRATEGY_IDS.map((strategyId) =>
    principalRow(strategyId, input.locate, input.outcomes, mcapPresent, nowMs),
  )
  const adjusters: CombinedScoreAdjuster[] = ADJUSTER_DOMAINS.map((domain) => ({
    domain,
    present: adjusterPresent.has(domain),
  }))

  const rugTrip = input.ohlcFailed || input.ohlcPatterns == null
    ? undefined
    : input.ohlcPatterns.rug.trip
  const storedWeights = input.weights ?? { ...COMBINED_SCORE_WEIGHTS }
  const mlScore =
    input.mlScore != null && Number.isFinite(input.mlScore) ? clamp01(input.mlScore) : null
  const weights = resolveCombinedScoreWeights(storedWeights, mlScore)

  return {
    success: true,
    mint: input.mint,
    chain: input.chain,
    hours,
    combined: combineParts(parts, weights, mlScore),
    weights,
    parts,
    principals,
    adjusters,
    ...(input.ohlcSource ? { ohlcSource: input.ohlcSource } : {}),
    ...(rugTrip != null ? { rugTrip } : {}),
    mlScore,
    modelVersion: input.modelVersion ?? null,
    generatedAt: input.generatedAt ?? new Date(nowMs).toISOString(),
  }
}
