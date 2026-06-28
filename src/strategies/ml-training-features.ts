import { computeTrainingClass, gateClassFromTrainingClass, potentialTierFromTrainingClass } from './outcome-labeling'
import { isLabeledTrainingClass, readTrainingClass } from './outcome-features'
import type { StrategyDomain, StrategyOutcomeRow, TrainingClass } from './types'

/** Minimum labeled outcomes before ML gate enforce mode is recommended. */
export const ML_MIN_LABELED_OUTCOMES = 200

export const ENTRY_MCAP_BANDS = [
  'under50k',
  '51-100k',
  '101-200k',
  '201-500k',
  '501k-1M',
  'over1M',
] as const

export type EntryMcapBandId = (typeof ENTRY_MCAP_BANDS)[number]

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

export const ML_V2_FEATURE_KEYS = [
  ...ML_NUMERIC_FEATURE_KEYS,
  ...ML_SOCIAL_FEATURE_KEYS,
] as const

export type MlNumericFeatureKey = (typeof ML_NUMERIC_FEATURE_KEYS)[number]

export type MlLabeledClass = 0 | 1 | 2 | 3 | 4

export type MlTrainingRow = {
  id: string
  strategy_id: string
  domain: StrategyDomain
  entry_at: string
  training_class: MlLabeledClass
  features: Record<string, number>
}

export type MlPnlBuckets = {
  negative: number
  zero_to_20: number
  twenty_to_50: number
  fifty_to_100: number
  hundred_to_300: number
  three_hundred_plus: number
  unknown: number
}

export type MlClassCounts = Record<'0' | '1' | '2' | '3' | '4', number>

export type MlGateClassCounts = Record<'0' | '1', number>

export type MlPotentialTierCounts = Record<'1' | '2' | '3' | '4', number>

export type MlDatasetStats = {
  min_required: number
  ready: boolean
  train_ready: boolean
  total_closed: number
  labeled: number
  unlabeled: number
  by_class: MlClassCounts
  by_gate_class: MlGateClassCounts
  potential_tier_counts: MlPotentialTierCounts
  pnl_buckets: MlPnlBuckets
  by_domain: Record<string, MlClassCounts>
  by_strategy: Record<string, MlClassCounts>
  entry_at_range: { earliest: string | null; latest: string | null }
}

function emptyClassCounts(): MlClassCounts {
  return { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0 }
}

function emptyGateClassCounts(): MlGateClassCounts {
  return { '0': 0, '1': 0 }
}

function emptyPotentialTierCounts(): MlPotentialTierCounts {
  return { '1': 0, '2': 0, '3': 0, '4': 0 }
}

function readFeatureNumber(
  features: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  const v = features?.[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function readEntryTemplate(
  features: Record<string, unknown> | null | undefined,
): 'first_seen' | 'milestone_80' | null {
  const v = features?.entry_template
  if (v === 'first_seen' || v === 'milestone_80') return v
  return null
}

export function log1p(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null
  return Math.log1p(value)
}

export function capTokenAgeHours(hours: number | null | undefined): number | null {
  if (hours == null || !Number.isFinite(hours) || hours < 0) return null
  return Math.min(hours, 168)
}

export function capMinutesSinceFirstMention(
  minutes: number | null | undefined,
): number {
  if (minutes == null || !Number.isFinite(minutes) || minutes < 0) return 0
  return Math.min(minutes, 720)
}

function readSocialFeatures(features: Record<string, unknown>): Record<string, number> {
  const mentions = readFeatureNumber(features, 'telegram_mention_count_30m') ?? 0
  const channels = readFeatureNumber(features, 'telegram_unique_channels_30m') ?? 0
  const minutes = capMinutesSinceFirstMention(
    readFeatureNumber(features, 'minutes_since_first_mention'),
  )
  const walletBuys = readFeatureNumber(features, 'smart_wallet_buy_count_1h') ?? 0
  const hasWallet =
    features.has_smart_wallet_buy === true ||
    walletBuys > 0
      ? 1
      : 0

  return {
    log_telegram_mention_count_30m: log1p(mentions) ?? 0,
    telegram_unique_channels_30m: channels,
    minutes_since_first_mention: minutes,
    smart_wallet_buy_count_1h: walletBuys,
    has_smart_wallet_buy: hasWallet,
  }
}

/** Stored class from features, or recomputed from pnl/status when missing. */
export function resolveEffectiveTrainingClass(
  row: Pick<StrategyOutcomeRow, 'features' | 'pnl_pct' | 'status'>,
  recompute = false,
): TrainingClass {
  if (!recompute) {
    const stored = readTrainingClass(row.features)
    if (isLabeledTrainingClass(stored)) return stored as MlLabeledClass
  }
  return computeTrainingClass(row.pnl_pct, row.status)
}

export function bucketPnl(pnl: number | null | undefined): keyof MlPnlBuckets {
  if (pnl == null || !Number.isFinite(pnl)) return 'unknown'
  if (pnl < 0) return 'negative'
  if (pnl < 20) return 'zero_to_20'
  if (pnl < 50) return 'twenty_to_50'
  if (pnl < 100) return 'fifty_to_100'
  if (pnl < 300) return 'hundred_to_300'
  return 'three_hundred_plus'
}

/** Entry-time numeric vector for ML v1 (mirrors ml/features.py). */
export function extractMlFeatureVector(
  features: Record<string, unknown> | null | undefined,
): Record<string, number> | null {
  return extractMlFeatureVectorV1(features)
}

export function extractMlFeatureVectorV1(
  features: Record<string, unknown> | null | undefined,
): Record<string, number> | null {
  if (!features) return null

  const entryMcap = readFeatureNumber(features, 'entry_mcap')
  const organic = readFeatureNumber(features, 'organic_score')
  const holders = readFeatureNumber(features, 'top_holders_pct')
  const age = capTokenAgeHours(readFeatureNumber(features, 'token_age_hours'))
  const volume =
    readFeatureNumber(features, 'volume_at_entry') ??
    readFeatureNumber(features, 'volume_5m')

  const logMcap = log1p(entryMcap)
  const logVol = log1p(volume)
  if (logMcap == null || organic == null || holders == null || age == null || logVol == null) {
    return null
  }

  const band = features.entry_mcap_band
  const vector: Record<string, number> = {
    log_entry_mcap: logMcap,
    organic_score: organic,
    top_holders_pct: holders,
    token_age_hours: age,
    log_volume_at_entry: logVol,
    entry_template_milestone_80: readEntryTemplate(features) === 'milestone_80' ? 1 : 0,
  }

  for (const bandId of ENTRY_MCAP_BANDS) {
    vector[`band_${bandId}`] = band === bandId ? 1 : 0
  }

  return vector
}

/** Entry-time vector including social/telegram features (ML v2). */
export function extractMlFeatureVectorV2(
  features: Record<string, unknown> | null | undefined,
): Record<string, number> | null {
  const base = extractMlFeatureVectorV1(features)
  if (!base) return null
  return {
    ...base,
    ...readSocialFeatures(features ?? {}),
  }
}

export function extractMlTrainingRowV2(
  row: StrategyOutcomeRow,
  recompute = false,
): MlTrainingRow | null {
  const trainingClass = resolveEffectiveTrainingClass(row, recompute)
  if (!isLabeledTrainingClass(trainingClass)) return null
  if (!row.entry_at) return null

  const features = extractMlFeatureVectorV2(row.features)
  if (!features) return null

  return {
    id: row.id,
    strategy_id: row.strategy_id,
    domain: row.domain,
    entry_at: row.entry_at,
    training_class: trainingClass,
    features,
  }
}

export function extractMlTrainingRow(
  row: StrategyOutcomeRow,
  recompute = false,
): MlTrainingRow | null {
  const trainingClass = resolveEffectiveTrainingClass(row, recompute)
  if (!isLabeledTrainingClass(trainingClass)) return null
  if (!row.entry_at) return null

  const features = extractMlFeatureVector(row.features)
  if (!features) return null

  return {
    id: row.id,
    strategy_id: row.strategy_id,
    domain: row.domain,
    entry_at: row.entry_at,
    training_class: trainingClass,
    features,
  }
}

export function hasTrainingClass(
  row: Pick<StrategyOutcomeRow, 'features' | 'pnl_pct' | 'status'>,
  recompute = false,
): boolean {
  return isLabeledTrainingClass(resolveEffectiveTrainingClass(row, recompute))
}

export function matchesTrainingClassFilter(
  row: StrategyOutcomeRow,
  options: { trainingClassOnly?: boolean; trainingClassMin?: number; recompute?: boolean },
): boolean {
  const tc = resolveEffectiveTrainingClass(row, options.recompute)
  if (!isLabeledTrainingClass(tc)) return false
  if (options.trainingClassMin != null && tc < options.trainingClassMin) return false
  if (options.trainingClassOnly) return true
  return true
}

function bumpClassCounts(map: Record<string, MlClassCounts>, key: string, cls: MlLabeledClass): void {
  const entry = map[key] ?? emptyClassCounts()
  entry[String(cls) as keyof MlClassCounts] += 1
  map[key] = entry
}

function countWinTiers(byClass: MlClassCounts): number {
  return (['1', '2', '3', '4'] as const).filter((k) => byClass[k] > 0).length
}

export function computeMlDatasetStats(rows: StrategyOutcomeRow[]): MlDatasetStats {
  let labeled = 0
  let unlabeled = 0
  const byClass = emptyClassCounts()
  const byGateClass = emptyGateClassCounts()
  const potentialTierCounts = emptyPotentialTierCounts()
  const pnlBuckets: MlPnlBuckets = {
    negative: 0,
    zero_to_20: 0,
    twenty_to_50: 0,
    fifty_to_100: 0,
    hundred_to_300: 0,
    three_hundred_plus: 0,
    unknown: 0,
  }
  const byDomain: MlDatasetStats['by_domain'] = {}
  const byStrategy: MlDatasetStats['by_strategy'] = {}
  let earliest: string | null = null
  let latest: string | null = null

  for (const row of rows) {
    if (row.entry_at) {
      if (!earliest || row.entry_at < earliest) earliest = row.entry_at
      if (!latest || row.entry_at > latest) latest = row.entry_at
    }

    pnlBuckets[bucketPnl(row.pnl_pct)] += 1

    const tc = resolveEffectiveTrainingClass(row, true)
    if (isLabeledTrainingClass(tc)) {
      labeled += 1
      byClass[String(tc) as keyof MlClassCounts] += 1
      const gate = gateClassFromTrainingClass(tc)
      if (gate != null) {
        byGateClass[String(gate) as keyof MlGateClassCounts] += 1
      }
      const tier = potentialTierFromTrainingClass(tc)
      if (tier != null) {
        potentialTierCounts[String(tier) as keyof MlPotentialTierCounts] += 1
      }
      bumpClassCounts(byDomain, row.domain, tc)
      bumpClassCounts(byStrategy, row.strategy_id, tc)
    } else {
      unlabeled += 1
    }
  }

  const winTiers = countWinTiers(byClass)
  const trainReady =
    labeled >= ML_MIN_LABELED_OUTCOMES &&
    (winTiers >= 2 || (byClass['0'] >= 10 && labeled - byClass['0'] >= 10))

  return {
    min_required: ML_MIN_LABELED_OUTCOMES,
    ready: labeled >= ML_MIN_LABELED_OUTCOMES,
    train_ready: trainReady,
    total_closed: rows.length,
    labeled,
    unlabeled,
    by_class: byClass,
    by_gate_class: byGateClass,
    potential_tier_counts: potentialTierCounts,
    pnl_buckets: pnlBuckets,
    by_domain: byDomain,
    by_strategy: byStrategy,
    entry_at_range: { earliest, latest },
  }
}
