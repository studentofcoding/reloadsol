/**
 * Single source of truth for the feature columns a model may declare.
 *
 * Every other list derives from here: the TS constants re-export, and `ml/feature-schema.json`
 * (committed) is the mirror the Python side reads. See docs/specs/SPEC-feature-registry-v1.md.
 *
 * Validation is by **set equality against a named set**. Inference is name-keyed
 * (`featureVectorToTensorInput` looks each declared column up in the vector and zero-fills a miss),
 * so membership is what matters — order is not a correctness axis.
 */

/** Bump only when a column is renamed, added or removed. Stamped on every canonical row. */
export const FEATURE_SCHEMA_VERSION = 1 as const

export const ENTRY_MCAP_BANDS = [
  'under50k',
  '51-100k',
  '101-200k',
  '201-500k',
  '501k-1M',
  'over1M',
] as const

export const ML_NUMERIC_FEATURE_KEYS = [
  'log_entry_mcap',
  'organic_score',
  'top_holders_pct',
  'token_age_hours',
  'log_volume_at_entry',
  'entry_template_milestone_80',
] as const

export const ML_SOCIAL_FEATURE_KEYS = [
  'log_telegram_mention_count_30m',
  'telegram_unique_channels_30m',
  'minutes_since_first_mention',
  'smart_wallet_buy_count_1h',
  'has_smart_wallet_buy',
] as const

export const PATTERN_FEATURE_KEYS = [
  'log_first_mcap',
  'log_mention_count_30m',
  'unique_channels_30m',
  'minutes_to_first_mention',
  'smart_wallet_buy_count_1h',
  'has_smart_wallet_buy',
  'source_gmgn_smart_money_fomo',
  'gmgn_activity_score_60m',
  'log_gmgn_sm_wallets_60m',
  'has_gmgn_hot_before_entry',
] as const

export const CLOSED_LOOP_FEATURE_COLUMNS = [
  'band_under50k',
  'band_51-100k',
  'band_101-200k',
  'band_201-500k',
  'band_501k-1M',
  'band_over1M',
  'adjuster_presence',
  'jaccard',
  'ohlc_pattern',
  'combined',
  'rug_trip',
  'principal_score',
  'entry_template_milestone_80',
] as const

const BAND_FEATURE_KEYS = ENTRY_MCAP_BANDS.map((band) => `band_${band}`)

/** 12 columns — numeric features plus the mcap-band one-hots. */
export const ENTRY_FEATURE_COLUMNS_V1: readonly string[] = [
  ...ML_NUMERIC_FEATURE_KEYS,
  ...BAND_FEATURE_KEYS,
]

/** 17 columns — v1 plus the social set. */
export const ENTRY_FEATURE_COLUMNS_V2: readonly string[] = [
  ...ENTRY_FEATURE_COLUMNS_V1,
  ...ML_SOCIAL_FEATURE_KEYS,
]

/** The numeric + social union (without bands) — used by the v2 vector builder and the trainers. */
export const ML_V2_FEATURE_KEYS = [
  ...ML_NUMERIC_FEATURE_KEYS,
  ...ML_SOCIAL_FEATURE_KEYS,
] as const

export type FeatureStage = 'entry' | 'pattern' | 'closed_loop'

/**
 * Named column sets per stage. A model's `feature_columns` must equal exactly one of these.
 * `entry` carries two because the gate and the potential head are trained on different widths today.
 */
export const FEATURE_REGISTRY = {
  version: FEATURE_SCHEMA_VERSION,
  stages: {
    entry: {
      v1: ENTRY_FEATURE_COLUMNS_V1,
      v2: ENTRY_FEATURE_COLUMNS_V2,
    },
    pattern: {
      default: PATTERN_FEATURE_KEYS,
    },
    closed_loop: {
      default: CLOSED_LOOP_FEATURE_COLUMNS,
    },
  },
} satisfies {
  version: number
  stages: Record<FeatureStage, Record<string, readonly string[]>>
}

export type ModelSchemaVerdict =
  | { ok: true; set: string }
  | { ok: false; reason: string }

export type FeatureSchemaMirror = {
  version: number
  stages: Record<string, Record<string, string[]>>
}

/**
 * The committed mirror (`ml/feature-schema.json`) the Python side reads — built here so the
 * emit script and the parity test share one implementation.
 */
export function buildSchemaMirror(): FeatureSchemaMirror {
  const stages: Record<string, Record<string, string[]>> = {}
  for (const stage of Object.keys(FEATURE_REGISTRY.stages) as FeatureStage[]) {
    stages[stage] = {}
    for (const [set, columns] of Object.entries(stageColumnSets(stage))) {
      stages[stage]![set] = [...columns]
    }
  }
  return { version: FEATURE_REGISTRY.version, stages }
}

export function serializeSchemaMirror(): string {
  return `${JSON.stringify(buildSchemaMirror(), null, 2)}\n`
}

export function stageColumnSets(
  stage: FeatureStage,
): Record<string, readonly string[]> {
  return FEATURE_REGISTRY.stages[stage] as Record<string, readonly string[]>
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(b)
  return a.every((key) => set.has(key))
}

function symmetricDifference(
  a: readonly string[],
  b: readonly string[],
): number {
  const setA = new Set(a)
  const setB = new Set(b)
  let diff = 0
  for (const key of setA) if (!setB.has(key)) diff++
  for (const key of setB) if (!setA.has(key)) diff++
  return diff
}

/**
 * Refuse a model whose declared columns do not match a named set for its stage.
 * The failure carries a *named* reason — unknown columns first, then the closest set's gaps —
 * because a bare `null` is what made the pattern-gate drift invisible.
 */
export function validateModelSchema(params: {
  stage: FeatureStage
  columns: readonly string[] | null | undefined
  version?: number | null
}): ModelSchemaVerdict {
  const sets = stageColumnSets(params.stage)
  const names = Object.keys(sets)

  if (params.version != null && params.version !== FEATURE_REGISTRY.version) {
    return {
      ok: false,
      reason: `feature_schema_version ${params.version} ≠ registry ${FEATURE_REGISTRY.version}`,
    }
  }

  const columns = params.columns
  if (!Array.isArray(columns) || columns.length === 0) {
    return { ok: false, reason: 'no feature_columns declared' }
  }

  for (const name of names) {
    if (sameMembers(columns, sets[name]!)) return { ok: true, set: name }
  }

  const known = new Set<string>()
  for (const name of names) for (const key of sets[name]!) known.add(key)
  const unknown = columns.filter((key) => !known.has(key))

  let closest = names[0]!
  let closestDiff = Number.POSITIVE_INFINITY
  for (const name of names) {
    const diff = symmetricDifference(columns, sets[name]!)
    if (diff < closestDiff) {
      closestDiff = diff
      closest = name
    }
  }
  const declared = new Set(columns)
  const missing = (sets[closest] ?? []).filter((key) => !declared.has(key))
  const extra = columns.filter((key) => !sets[closest]!.includes(key))

  const parts = [`${columns.length} columns match no ${params.stage} set`]
  if (unknown.length > 0) parts.push(`unknown: ${unknown.join(', ')}`)
  if (missing.length > 0) parts.push(`missing vs ${closest}: ${missing.join(', ')}`)
  if (extra.length > 0) parts.push(`extra vs ${closest}: ${extra.join(', ')}`)
  return { ok: false, reason: parts.join(' · ') }
}
