/**
 * Lego recipe gate evaluator (SPEC default AND hard-reject + optional BM opt-in).
 *
 * Default pack (on unless a recipe turns a gate off):
 * - membership: mint on universe list
 * - mcap ≥ 50_000 (missing fail closed)
 * - liquidity ≥ 10_000 (missing fail closed)
 * - climateSafe: Header climate chip label must be Safe
 *
 * Optional / strategy (off unless recipe opts in):
 * - bmScore: score100 > N (default N=45) — strategy-only, never default
 * - bmFresh: freshWalletsPct < N (default N=25)
 * - bmTop10: top10AdjustedPct < N (default N=40)
 *
 * climateSafe reuses climateDisplay chip helpers (isClimateChipSafe / climateChipLabel).
 * No brain entry scores. No live execute wiring here.
 */

import {
  climateChipLabel,
  isClimateChipSafe,
  type ClimateChipLabel,
  type ClimateChipPayload,
} from '@/utils/climateDisplay'
import type { ClimateState } from '@/utils/climateGate'
import {
  asFiniteNumber,
  mcapFactsFromBrainToken,
  signalsFactsFromBrainToken,
  type BrainListToken,
  type LegoDomain,
  type LegoRecipe,
} from '@/utils/market-brain'

export const DEFAULT_GATE_IDS = ['membership', 'mcap', 'liquidity', 'climateSafe'] as const
export const OPTIONAL_GATE_IDS = ['bmScore', 'bmFresh', 'bmTop10'] as const

export type DefaultGateId = (typeof DEFAULT_GATE_IDS)[number]
export type OptionalGateId = (typeof OPTIONAL_GATE_IDS)[number]
export type GateId = DefaultGateId | OptionalGateId

export const DEFAULT_MCAP_MIN_USD = 50_000
export const DEFAULT_LIQUIDITY_MIN_USD = 10_000
export const DEFAULT_BM_SCORE_MIN = 45
export const DEFAULT_BM_FRESH_MAX_PCT = 25
export const DEFAULT_BM_TOP10_MAX_PCT = 40

export type GateSpec = {
  id: GateId
  enabled?: boolean
  min?: number
  max?: number
}

export type ResolvedGate = {
  id: GateId
  enabled: boolean
  min?: number
  max?: number
  optional: boolean
}

export type GateTokenFacts = {
  mint: string
  marketCap?: number | null
  liquidity?: number | null
  score100?: number | null
  freshWalletsPct?: number | null
  top10AdjustedPct?: number | null
}

export type GateClimateFields = {
  ok: boolean
  error?: string
  stale?: boolean
  cascadeVeto: boolean
  state: ClimateState | string | null
}

export type GateEvalResult = {
  pass: boolean
  rejectedBy: GateId[]
  reasons: string[]
  gates: ResolvedGate[]
}

const DEFAULT_IDS = new Set<string>(DEFAULT_GATE_IDS)
const OPTIONAL_IDS = new Set<string>(OPTIONAL_GATE_IDS)
const ALL_IDS = new Set<string>([...DEFAULT_GATE_IDS, ...OPTIONAL_GATE_IDS])

function isGateId(value: unknown): value is GateId {
  return typeof value === 'string' && ALL_IDS.has(value)
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function gateIdFromUnknown(value: unknown): GateId | null {
  if (isGateId(value)) return value
  const obj = asObject(value)
  if (!obj) return null
  for (const key of ['id', 'kind', 'name', 'type', 'gate']) {
    if (isGateId(obj[key])) return obj[key] as GateId
  }
  return null
}

function parseSpec(value: unknown): GateSpec | null {
  if (isGateId(value)) return { id: value, enabled: true }
  const obj = asObject(value)
  if (!obj) return null
  const id = gateIdFromUnknown(obj)
  if (!id) return null
  const enabled =
    obj.enabled === false || obj.on === false || obj.off === true ? false : true
  const min = asFiniteNumber(obj.min ?? obj.n ?? obj.threshold)
  const max = asFiniteNumber(obj.max ?? (id === 'bmFresh' || id === 'bmTop10' ? obj.n : null))
  return {
    id,
    enabled,
    min: min ?? undefined,
    max: max ?? undefined,
  }
}

function defaultThresholds(id: GateId): { min?: number; max?: number } {
  if (id === 'mcap') return { min: DEFAULT_MCAP_MIN_USD }
  if (id === 'liquidity') return { min: DEFAULT_LIQUIDITY_MIN_USD }
  if (id === 'bmScore') return { min: DEFAULT_BM_SCORE_MIN }
  if (id === 'bmFresh') return { max: DEFAULT_BM_FRESH_MAX_PCT }
  if (id === 'bmTop10') return { max: DEFAULT_BM_TOP10_MAX_PCT }
  return {}
}

/**
 * Resolve recipe.gates onto the default AND pack.
 * Defaults stay on unless explicitly disabled. Optional BM gates stay off
 * unless the recipe lists them (and does not set enabled:false).
 */
export function resolveRecipeGates(gates: unknown): ResolvedGate[] {
  const byId = new Map<GateId, GateSpec>()

  if (Array.isArray(gates)) {
    for (const row of gates) {
      const spec = parseSpec(row)
      if (spec) byId.set(spec.id, spec)
    }
  } else {
    const obj = asObject(gates)
    if (obj) {
      for (const [key, value] of Object.entries(obj)) {
        if (!isGateId(key)) continue
        if (value === false) {
          byId.set(key, { id: key, enabled: false })
          continue
        }
        if (value === true) {
          byId.set(key, { id: key, enabled: true })
          continue
        }
        const n = asFiniteNumber(value)
        if (n != null) {
          const spec: GateSpec = { id: key, enabled: true }
          if (key === 'bmFresh' || key === 'bmTop10') spec.max = n
          else spec.min = n
          byId.set(key, spec)
          continue
        }
        const nested = parseSpec({ id: key, ...(asObject(value) ?? {}) })
        if (nested) byId.set(key, nested)
      }
    }
  }

  const resolved: ResolvedGate[] = []
  for (const id of DEFAULT_GATE_IDS) {
    const spec = byId.get(id)
    const thresholds = defaultThresholds(id)
    resolved.push({
      id,
      enabled: spec?.enabled !== false,
      min: spec?.min ?? thresholds.min,
      max: spec?.max ?? thresholds.max,
      optional: false,
    })
  }
  for (const id of OPTIONAL_GATE_IDS) {
    const spec = byId.get(id)
    if (!spec || spec.enabled === false) {
      resolved.push({
        id,
        enabled: false,
        ...defaultThresholds(id),
        optional: true,
      })
      continue
    }
    const thresholds = defaultThresholds(id)
    resolved.push({
      id,
      enabled: true,
      min: spec.min ?? thresholds.min,
      max: spec.max ?? thresholds.max,
      optional: true,
    })
  }
  return resolved
}

export function brainTokenToGateFacts(token: BrainListToken): GateTokenFacts {
  return {
    mint: token.mint,
    marketCap: token.marketCap,
    liquidity: token.liquidity,
    score100: token.score100,
    freshWalletsPct: token.freshWalletsPct,
    top10AdjustedPct: token.top10AdjustedPct,
  }
}

export function resolveClimateChipLabel(
  climate:
    | ClimateChipLabel
    | ClimateChipPayload
    | GateClimateFields
    | { label?: ClimateChipLabel | string | null }
    | null
    | undefined,
): ClimateChipLabel | null {
  if (climate == null) return null
  if (typeof climate === 'string') {
    return climate === 'Safe' || climate === 'Not safe' || climate === 'Unknown'
      ? climate
      : null
  }
  const obj = climate as Record<string, unknown>
  if (typeof obj.label === 'string') {
    const label = obj.label
    if (label === 'Safe' || label === 'Not safe' || label === 'Unknown') return label
  }
  if (typeof obj.ok === 'boolean' && 'cascadeVeto' in obj) {
    return climateChipLabel({
      ok: obj.ok === true,
      error: typeof obj.error === 'string' ? obj.error : undefined,
      stale: obj.stale === true,
      cascadeVeto: obj.cascadeVeto === true,
      state: (obj.state as ClimateState | string | null) ?? null,
    })
  }
  return null
}

function reject(
  id: GateId,
  reason: string,
): { id: GateId; reason: string } {
  return { id, reason }
}

function evalGate(
  gate: ResolvedGate,
  token: GateTokenFacts,
  universe: Set<string>,
  climateLabel: ClimateChipLabel | null,
): { id: GateId; reason: string } | null {
  if (!gate.enabled) return null

  if (gate.id === 'membership') {
    const mint = token.mint?.trim() ?? ''
    if (!mint || !universe.has(mint)) {
      return reject('membership', 'mint not on recipe universe list')
    }
    return null
  }

  if (gate.id === 'mcap') {
    const min = gate.min ?? DEFAULT_MCAP_MIN_USD
    const mcap = asFiniteNumber(token.marketCap)
    if (mcap == null) return reject('mcap', 'marketCap missing (fail closed)')
    if (!(mcap >= min)) {
      return reject('mcap', `marketCap ${mcap} < ${min}`)
    }
    return null
  }

  if (gate.id === 'liquidity') {
    const min = gate.min ?? DEFAULT_LIQUIDITY_MIN_USD
    const liq = asFiniteNumber(token.liquidity)
    if (liq == null) return reject('liquidity', 'liquidity missing (fail closed)')
    if (!(liq >= min)) {
      return reject('liquidity', `liquidity ${liq} < ${min}`)
    }
    return null
  }

  if (gate.id === 'climateSafe') {
    if (!isClimateChipSafe(climateLabel)) {
      return reject(
        'climateSafe',
        `climate chip is ${climateLabel ?? 'missing'} (Safe required)`,
      )
    }
    return null
  }

  if (gate.id === 'bmScore') {
    const min = gate.min ?? DEFAULT_BM_SCORE_MIN
    const score = asFiniteNumber(token.score100)
    if (score == null) return reject('bmScore', 'score100 missing (fail closed)')
    if (!(score > min)) {
      return reject('bmScore', `score100 ${score} <= ${min}`)
    }
    return null
  }

  if (gate.id === 'bmFresh') {
    const max = gate.max ?? DEFAULT_BM_FRESH_MAX_PCT
    const pct = asFiniteNumber(token.freshWalletsPct)
    if (pct == null) return reject('bmFresh', 'freshWalletsPct missing (fail closed)')
    if (!(pct < max)) {
      return reject('bmFresh', `freshWalletsPct ${pct} >= ${max}`)
    }
    return null
  }

  if (gate.id === 'bmTop10') {
    const max = gate.max ?? DEFAULT_BM_TOP10_MAX_PCT
    const pct = asFiniteNumber(token.top10AdjustedPct)
    if (pct == null) return reject('bmTop10', 'top10AdjustedPct missing (fail closed)')
    if (!(pct < max)) {
      return reject('bmTop10', `top10AdjustedPct ${pct} >= ${max}`)
    }
    return null
  }

  return null
}

export type EvaluateRecipeGatesInput = {
  token: GateTokenFacts
  universeMints?: Iterable<string> | null
  climate?:
    | ClimateChipLabel
    | ClimateChipPayload
    | GateClimateFields
    | { label?: ClimateChipLabel | string | null }
    | null
  /** Recipe `gates` field, GateSpec[], or omit for the default pack. */
  gates?: unknown
}

export function evaluateRecipeGates(input: EvaluateRecipeGatesInput): GateEvalResult {
  const gates = resolveRecipeGates(input.gates)
  const universe = new Set<string>()
  if (input.universeMints) {
    for (const mint of input.universeMints) {
      const trimmed = mint?.trim()
      if (trimmed) universe.add(trimmed)
    }
  }
  const climateLabel = resolveClimateChipLabel(input.climate)
  const rejectedBy: GateId[] = []
  const reasons: string[] = []

  for (const gate of gates) {
    const hit = evalGate(gate, input.token, universe, climateLabel)
    if (hit) {
      rejectedBy.push(hit.id)
      reasons.push(hit.reason)
    }
  }

  return {
    pass: rejectedBy.length === 0,
    rejectedBy,
    reasons,
    gates,
  }
}

export function pickLegoRecipe(
  recipes: Iterable<LegoRecipe>,
  opts: { recipeId?: string; domain?: LegoDomain } = {},
): LegoRecipe | null {
  const list = Array.isArray(recipes) ? recipes : [...recipes]
  if (opts.recipeId) {
    const exact = list.find((recipe) => recipe.id === opts.recipeId)
    if (exact) return exact
  }
  if (opts.domain) {
    return list.find((recipe) => recipe.domain === opts.domain && recipe.active) ?? null
  }
  return null
}

/**
 * Default AND pack for brain-backed sim opens.
 * Prefers brain list facts (`mcapFactsFromBrainToken` / `signalsFactsFromBrainToken`);
 * local mcap fills in when the list row omits it. No bmScore unless the recipe opts in.
 */
export function evaluateBrainBackedOpen(params: {
  mint: string
  localMarketCap?: number | null
  localLiquidity?: number | null
  brainToken?: BrainListToken | null
  universeMints: Iterable<string>
  climate?: EvaluateRecipeGatesInput['climate']
  gates?: unknown
  recipe?: LegoRecipe | null
}): GateEvalResult {
  const mint = params.mint.trim()
  const mcapFacts = params.brainToken
    ? mcapFactsFromBrainToken(params.brainToken)
    : { mint, marketCap: null as number | null, liquidity: null as number | null }
  const signalFacts = params.brainToken ? signalsFactsFromBrainToken(params.brainToken) : null
  const bm = params.brainToken ? brainTokenToGateFacts(params.brainToken) : null
  return evaluateRecipeGates({
    token: {
      mint,
      marketCap: mcapFacts.marketCap ?? params.localMarketCap ?? null,
      liquidity: mcapFacts.liquidity ?? params.localLiquidity ?? null,
      score100: signalFacts?.score100 ?? bm?.score100 ?? null,
      freshWalletsPct: bm?.freshWalletsPct ?? null,
      top10AdjustedPct: bm?.top10AdjustedPct ?? null,
    },
    universeMints: params.universeMints,
    climate: params.climate,
    gates: params.gates ?? params.recipe?.gates,
  })
}
