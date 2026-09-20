/**
 * Phase 4 closed-loop entry-pattern model (pure).
 *
 * Labeled principal strategy_outcomes → lightweight logistic (or heuristic
 * ensemble when the set is thin) → mlScore ∈ [0, 1]. Combined-score consumes
 * that as an optional `ml` weight. Missing model / flag off → null, no throw.
 */
import { scoreClosedLoopLogistic } from './entry-pattern-scorer'
import {
  computeEntryMcapBand,
  readEntryMcap,
  type EntryMcapBand,
} from './outcome-features'
import { computeGateClass, type GateClass } from './outcome-labeling'
import type { CombinedScoreAdjuster, CombinedScoreParts } from './combined-score'
import type { StrategyOutcomeRow } from './types'

export const CLOSED_LOOP_PRINCIPAL_IDS = [
  'mcap_enter_first_seen',
  'mcap_enter_at_80',
  'mcap_enter_first_seen_rh',
  'mcap_enter_at_80_rh',
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

export type ClosedLoopFeatureKey = (typeof CLOSED_LOOP_FEATURE_COLUMNS)[number]

export const DEFAULT_CLOSED_LOOP_ARTIFACT = 'data/ml-closed-loop/model.json'
export const MIN_CLOSED_LOOP_TRAIN_ROWS = 8
export const CLOSED_LOOP_HEURISTIC_WEIGHTS = {
  principal: 0.35,
  adjuster: 0.2,
  jaccard: 0.15,
  ohlc: 0.15,
  noRug: 0.15,
} as const

export type ClosedLoopModelType = 'logistic' | 'heuristic'

export type ClosedLoopModelArtifact = {
  version: string
  model_type: ClosedLoopModelType
  trainedAt: string
  feature_columns: string[]
  weights: number[]
  bias: number
  principals_only: true
  label: 'ml_win'
  metrics: {
    n: number
    positives: number
    negatives: number
    accuracy?: number
    note?: string
  }
}

export type ClosedLoopTrainRow = {
  id: string
  strategy_id: string
  features: Record<ClosedLoopFeatureKey, number>
  label: 0 | 1
}

export type ClosedLoopTrainResult = {
  model: ClosedLoopModelArtifact
  skipped_unlabeled: number
  skipped_not_principal: number
  used: number
}

export type ClosedLoopScoreSnapshot = {
  parts: CombinedScoreParts
  /** 4-key combined (before the ml adjuster) — never the post-ml score. */
  combinedBase: number
  rugTrip?: boolean
  adjusters?: CombinedScoreAdjuster[]
  entryMcapBand?: string | null
  milestone80?: boolean
}

export function isMlClosedLoopEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.ML_CLOSED_LOOP?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

export function isClosedLoopPrincipalId(strategyId: string | null | undefined): boolean {
  return (
    strategyId === 'mcap_enter_first_seen' ||
    strategyId === 'mcap_enter_first_seen_rh' ||
    strategyId === 'mcap_enter_at_80' ||
    strategyId === 'mcap_enter_at_80_rh'
  )
}

export function resolveClosedLoopArtifactPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.ML_CLOSED_LOOP_ARTIFACT?.trim()
  return raw || DEFAULT_CLOSED_LOOP_ARTIFACT
}

function clamp01(n: number): number {
  if (Number.isNaN(n) || n <= 0) return 0
  if (n >= 1) return 1
  return n
}

function finite01(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return clamp01(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return clamp01(n)
  }
  return fallback
}

function readBand(features: Record<string, unknown> | null | undefined): EntryMcapBand | null {
  const stored = features?.entry_mcap_band
  if (
    stored === 'under50k' ||
    stored === '51-100k' ||
    stored === '101-200k' ||
    stored === '201-500k' ||
    stored === '501k-1M' ||
    stored === 'over1M'
  ) {
    return stored
  }
  return computeEntryMcapBand(readEntryMcap(features))
}

function isMilestone80(
  features: Record<string, unknown> | null | undefined,
  strategyId?: string | null,
): boolean {
  if (features?.entry_template === 'milestone_80') return true
  if (features?.entry_template_milestone_80 === 1 || features?.entry_template_milestone_80 === true) {
    return true
  }
  return strategyId === 'mcap_enter_at_80' || strategyId === 'mcap_enter_at_80_rh'
}

function emptyFeatureRecord(): Record<ClosedLoopFeatureKey, number> {
  const out = {} as Record<ClosedLoopFeatureKey, number>
  for (const key of CLOSED_LOOP_FEATURE_COLUMNS) out[key] = 0
  return out
}

export function featureRecordToVector(
  record: Record<string, number>,
  columns: readonly string[] = CLOSED_LOOP_FEATURE_COLUMNS,
): number[] {
  return columns.map((key) => {
    const v = record[key]
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  })
}

export function bandOneHot(band: string | null | undefined): Record<string, number> {
  const keys = [
    'band_under50k',
    'band_51-100k',
    'band_101-200k',
    'band_201-500k',
    'band_501k-1M',
    'band_over1M',
  ] as const
  const out: Record<string, number> = {}
  for (const key of keys) out[key] = 0
  if (band === 'under50k') out.band_under50k = 1
  else if (band === '51-100k') out['band_51-100k'] = 1
  else if (band === '101-200k') out['band_101-200k'] = 1
  else if (band === '201-500k') out['band_201-500k'] = 1
  else if (band === '501k-1M') out['band_501k-1M'] = 1
  else if (band === 'over1M') out['band_over1M'] = 1
  return out
}

export function extractClosedLoopFeaturesFromSnapshot(
  snapshot: ClosedLoopScoreSnapshot,
): Record<ClosedLoopFeatureKey, number> {
  const band = snapshot.entryMcapBand ?? null
  const adjuster =
    snapshot.adjusters && snapshot.adjusters.length > 0
      ? snapshot.adjusters.filter((row) => row.present).length / snapshot.adjusters.length
      : snapshot.parts.adjusterPresenceScore
  const out = emptyFeatureRecord()
  Object.assign(out, bandOneHot(band))
  out.adjuster_presence = clamp01(adjuster)
  out.jaccard =
    snapshot.parts.jaccardScore == null || !Number.isFinite(snapshot.parts.jaccardScore)
      ? 0
      : clamp01(snapshot.parts.jaccardScore)
  out.ohlc_pattern = clamp01(snapshot.parts.ohlcPatternScore)
  out.combined = clamp01(snapshot.combinedBase)
  out.rug_trip = snapshot.rugTrip === true ? 1 : 0
  out.principal_score = clamp01(snapshot.parts.principalScore)
  out.entry_template_milestone_80 = snapshot.milestone80 ? 1 : 0
  return out
}

function readStoredScore(features: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const v = features[key]
    if (typeof v === 'number' && Number.isFinite(v)) return clamp01(v)
  }
  return null
}

/**
 * Entry-time snapshot from a closed principal outcome. Missing combined /
 * Jaccard / OHLC fields are imputed (0.5 / 0 / 0.5) so historical rows still
 * train. Never reads exit PnL into the vector.
 */
export function extractClosedLoopFeaturesFromOutcome(
  row: Pick<StrategyOutcomeRow, 'features' | 'strategy_id'>,
): Record<ClosedLoopFeatureKey, number> {
  const features = row.features ?? {}
  const band = readBand(features)
  const out = emptyFeatureRecord()
  Object.assign(out, bandOneHot(band))

  const adjuster =
    readStoredScore(features, 'adjuster_presence_score', 'adjusterPresenceScore') ??
    (typeof features.adjuster_count === 'number' && Number.isFinite(features.adjuster_count)
      ? clamp01(features.adjuster_count / 4)
      : 0)
  out.adjuster_presence = adjuster
  out.jaccard = readStoredScore(features, 'jaccard_score', 'jaccardScore') ?? 0
  out.ohlc_pattern = readStoredScore(features, 'ohlc_pattern_score', 'ohlcPatternScore') ?? 0.5
  out.combined = readStoredScore(features, 'combined_base', 'combined') ?? 0.5
  out.rug_trip =
    features.rugTrip === true || features.rug_trip === true || features.rug_trip === 1 ? 1 : 0
  out.principal_score = readStoredScore(features, 'principal_score', 'principalScore') ?? 0.5
  out.entry_template_milestone_80 = isMilestone80(features, row.strategy_id) ? 1 : 0
  return out
}

export function closedLoopLabelFromOutcome(
  row: Pick<StrategyOutcomeRow, 'features' | 'pnl_pct' | 'status'>,
): GateClass | null {
  const stored = row.features?.ml_win
  if (stored === 0 || stored === 1) return stored
  if (stored === '0' || stored === '1') return Number(stored) as GateClass
  return computeGateClass(row.pnl_pct, row.status)
}

export function collectClosedLoopTrainRows(
  rows: StrategyOutcomeRow[],
): { rows: ClosedLoopTrainRow[]; skipped_unlabeled: number; skipped_not_principal: number } {
  const out: ClosedLoopTrainRow[] = []
  let skipped_unlabeled = 0
  let skipped_not_principal = 0
  for (const row of rows) {
    if (!isClosedLoopPrincipalId(row.strategy_id)) {
      skipped_not_principal += 1
      continue
    }
    const label = closedLoopLabelFromOutcome(row)
    if (label == null) {
      skipped_unlabeled += 1
      continue
    }
    out.push({
      id: row.id,
      strategy_id: row.strategy_id,
      features: extractClosedLoopFeaturesFromOutcome(row),
      label,
    })
  }
  return { rows: out, skipped_unlabeled, skipped_not_principal }
}

export function inferClosedLoopScore(
  record: Record<string, number>,
  model: ClosedLoopModelArtifact,
): number {
  if (model.model_type === 'heuristic') {
    return heuristicClosedLoopScore(record)
  }
  const vector = featureRecordToVector(record, model.feature_columns)
  return clamp01(scoreClosedLoopLogistic(vector, model.weights, model.bias))
}

export function heuristicClosedLoopScore(record: Record<string, number>): number {
  const w = CLOSED_LOOP_HEURISTIC_WEIGHTS
  return clamp01(
    w.principal * finite01(record.principal_score, 0.5) +
      w.adjuster * finite01(record.adjuster_presence) +
      w.jaccard * finite01(record.jaccard) +
      w.ohlc * finite01(record.ohlc_pattern, 0.5) +
      w.noRug * (1 - finite01(record.rug_trip)),
  )
}

function trainLogistic(
  X: number[][],
  y: number[],
): { weights: number[]; bias: number; accuracy: number } {
  const n = X.length
  const d = X[0]?.length ?? 0
  const weights = new Array<number>(d).fill(0)
  let bias = 0
  const lr = 0.25
  const l2 = 0.02
  const epochs = 500
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array<number>(d).fill(0)
    let gradB = 0
    for (let i = 0; i < n; i++) {
      const p = scoreClosedLoopLogistic(X[i], weights, bias)
      const err = p - y[i]
      for (let j = 0; j < d; j++) gradW[j] += err * X[i][j]
      gradB += err
    }
    for (let j = 0; j < d; j++) {
      weights[j] -= lr * (gradW[j] / n + l2 * weights[j])
    }
    bias -= lr * (gradB / n)
  }
  let correct = 0
  for (let i = 0; i < n; i++) {
    const p = scoreClosedLoopLogistic(X[i], weights, bias)
    if ((p >= 0.5 ? 1 : 0) === y[i]) correct += 1
  }
  return { weights, bias, accuracy: n > 0 ? correct / n : 0 }
}

export function makeClosedLoopVersion(now = new Date()): string {
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  const t = now.getUTCHours().toString(16) + now.getUTCMinutes().toString(16)
  return `cl-${y}${m}${d}-${t}${now.getUTCSeconds().toString(16)}`
}

export function trainClosedLoopModel(
  rows: ClosedLoopTrainRow[],
  opts?: { now?: Date; version?: string },
): ClosedLoopModelArtifact {
  const now = opts?.now ?? new Date()
  const version = opts?.version ?? makeClosedLoopVersion(now)
  const positives = rows.filter((r) => r.label === 1).length
  const negatives = rows.length - positives
  const trainedAt = now.toISOString()

  if (rows.length < MIN_CLOSED_LOOP_TRAIN_ROWS) {
    return {
      version,
      model_type: 'heuristic',
      trainedAt,
      feature_columns: [...CLOSED_LOOP_FEATURE_COLUMNS],
      weights: [],
      bias: 0,
      principals_only: true,
      label: 'ml_win',
      metrics: {
        n: rows.length,
        positives,
        negatives,
        note: `n<${MIN_CLOSED_LOOP_TRAIN_ROWS}; heuristic ensemble`,
      },
    }
  }

  const X = rows.map((r) => featureRecordToVector(r.features))
  const y = rows.map((r) => r.label)
  const fitted = trainLogistic(X, y)
  return {
    version,
    model_type: 'logistic',
    trainedAt,
    feature_columns: [...CLOSED_LOOP_FEATURE_COLUMNS],
    weights: fitted.weights,
    bias: fitted.bias,
    principals_only: true,
    label: 'ml_win',
    metrics: {
      n: rows.length,
      positives,
      negatives,
      accuracy: Math.round(fitted.accuracy * 1e4) / 1e4,
    },
  }
}

export function parseClosedLoopModel(raw: unknown): ClosedLoopModelArtifact | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.version !== 'string' || !obj.version.trim()) return null
  if (obj.model_type !== 'logistic' && obj.model_type !== 'heuristic') return null
  if (!Array.isArray(obj.feature_columns) || obj.feature_columns.length === 0) return null
  if (!Array.isArray(obj.weights)) return null
  if (typeof obj.bias !== 'number' || !Number.isFinite(obj.bias)) return null
  const columns = obj.feature_columns.filter((c): c is string => typeof c === 'string')
  if (columns.length === 0) return null
  const weights = obj.weights.map((w) => (typeof w === 'number' && Number.isFinite(w) ? w : 0))
  return {
    version: obj.version,
    model_type: obj.model_type,
    trainedAt: typeof obj.trainedAt === 'string' ? obj.trainedAt : '',
    feature_columns: columns,
    weights,
    bias: obj.bias,
    principals_only: true,
    label: 'ml_win',
    metrics: {
      n: typeof (obj.metrics as { n?: unknown } | undefined)?.n === 'number'
        ? (obj.metrics as { n: number }).n
        : 0,
      positives:
        typeof (obj.metrics as { positives?: unknown } | undefined)?.positives === 'number'
          ? (obj.metrics as { positives: number }).positives
          : 0,
      negatives:
        typeof (obj.metrics as { negatives?: unknown } | undefined)?.negatives === 'number'
          ? (obj.metrics as { negatives: number }).negatives
          : 0,
      accuracy:
        typeof (obj.metrics as { accuracy?: unknown } | undefined)?.accuracy === 'number'
          ? (obj.metrics as { accuracy: number }).accuracy
          : undefined,
      note:
        typeof (obj.metrics as { note?: unknown } | undefined)?.note === 'string'
          ? (obj.metrics as { note: string }).note
          : undefined,
    },
  }
}

