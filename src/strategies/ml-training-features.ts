import { readTrainingClass } from './outcome-features'
import type { StrategyDomain, StrategyOutcomeRow } from './types'

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

export type MlNumericFeatureKey = (typeof ML_NUMERIC_FEATURE_KEYS)[number]

export type MlTrainingRow = {
  id: string
  strategy_id: string
  domain: StrategyDomain
  entry_at: string
  training_class: 0 | 1
  features: Record<string, number>
}

export type MlDatasetStats = {
  min_required: number
  ready: boolean
  total_closed: number
  labeled: number
  class_0: number
  class_1: number
  marginal: number
  unlabeled: number
  by_domain: Record<string, { labeled: number; class_0: number; class_1: number }>
  by_strategy: Record<string, { labeled: number; class_0: number; class_1: number }>
  entry_at_range: { earliest: string | null; latest: string | null }
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

/** Entry-time numeric vector for ML (mirrors ml/features.py). */
export function extractMlFeatureVector(
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

export function extractMlTrainingRow(row: StrategyOutcomeRow): MlTrainingRow | null {
  const trainingClass = readTrainingClass(row.features)
  if (trainingClass !== 0 && trainingClass !== 1) return null
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

export function hasTrainingClass(features: Record<string, unknown> | null | undefined): boolean {
  const tc = readTrainingClass(features)
  return tc === 0 || tc === 1
}

function bumpDomainStrategy(
  map: Record<string, { labeled: number; class_0: number; class_1: number }>,
  key: string,
  trainingClass: 0 | 1,
): void {
  const entry = map[key] ?? { labeled: 0, class_0: 0, class_1: 0 }
  entry.labeled += 1
  if (trainingClass === 0) entry.class_0 += 1
  else entry.class_1 += 1
  map[key] = entry
}

export function computeMlDatasetStats(rows: StrategyOutcomeRow[]): MlDatasetStats {
  let labeled = 0
  let class0 = 0
  let class1 = 0
  let marginal = 0
  let unlabeled = 0
  const byDomain: MlDatasetStats['by_domain'] = {}
  const byStrategy: MlDatasetStats['by_strategy'] = {}
  let earliest: string | null = null
  let latest: string | null = null

  for (const row of rows) {
    if (row.entry_at) {
      if (!earliest || row.entry_at < earliest) earliest = row.entry_at
      if (!latest || row.entry_at > latest) latest = row.entry_at
    }

    const tc = readTrainingClass(row.features)
    if (tc === 0) {
      labeled += 1
      class0 += 1
      bumpDomainStrategy(byDomain, row.domain, 0)
      bumpDomainStrategy(byStrategy, row.strategy_id, 0)
    } else if (tc === 1) {
      labeled += 1
      class1 += 1
      bumpDomainStrategy(byDomain, row.domain, 1)
      bumpDomainStrategy(byStrategy, row.strategy_id, 1)
    } else if (tc === null && row.pnl_pct != null) {
      marginal += 1
    } else {
      unlabeled += 1
    }
  }

  return {
    min_required: ML_MIN_LABELED_OUTCOMES,
    ready: labeled >= ML_MIN_LABELED_OUTCOMES,
    total_closed: rows.length,
    labeled,
    class_0: class0,
    class_1: class1,
    marginal,
    unlabeled,
    by_domain: byDomain,
    by_strategy: byStrategy,
    entry_at_range: { earliest, latest },
  }
}
