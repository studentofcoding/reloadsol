import { buildEntryMcapFeatures } from './outcome-features'

export type MonitorSnapshot = {
  timestamp: string
  price_usd?: number | null
  volume_5m?: number | null
  market_cap?: number | null
}

export type EntryFeatureSnapshotInput = {
  entryAt?: string | null
  firstSeenAt?: string | null
  entryMcap?: number | null
  organicScore?: number | null
  topHoldersPct?: number | null
  volume5m?: number | null
  tokenSymbol?: string | null
  monitorSnapshots?: MonitorSnapshot[]
}

export function computeTokenAgeHours(
  entryAt: string | null | undefined,
  firstSeenAt: string | null | undefined,
): number | null {
  if (!entryAt || !firstSeenAt) return null
  const entryMs = new Date(entryAt).getTime()
  const firstMs = new Date(firstSeenAt).getTime()
  if (!Number.isFinite(entryMs) || !Number.isFinite(firstMs)) return null
  const diff = entryMs - firstMs
  if (diff < 0) return 0
  return Math.round((diff / (1000 * 60 * 60)) * 100) / 100
}

export function buildEntryFeatureSnapshot(
  input: EntryFeatureSnapshotInput,
): Record<string, unknown> {
  const entryAt = input.entryAt ?? new Date().toISOString()
  const volume5m = input.volume5m ?? null
  const snapshot: Record<string, unknown> = {
    ...buildEntryMcapFeatures(input.entryMcap),
    organic_score: input.organicScore ?? null,
    top_holders_pct: input.topHoldersPct ?? null,
    token_age_hours: computeTokenAgeHours(entryAt, input.firstSeenAt),
    volume_5m: volume5m,
    volume_at_entry: volume5m,
    first_seen_at: input.firstSeenAt ?? null,
    monitor_snapshots: input.monitorSnapshots ?? [],
  }
  if (input.tokenSymbol) {
    snapshot.token_symbol = input.tokenSymbol
  }
  return snapshot
}

export function appendMonitorSnapshot(
  existing: MonitorSnapshot[] | undefined,
  snapshot: MonitorSnapshot,
  max = 288,
): MonitorSnapshot[] {
  return [...(existing ?? []), snapshot].slice(-max)
}

export function readMonitorSnapshotsFromFeatures(
  features: Record<string, unknown> | null | undefined,
): MonitorSnapshot[] {
  const raw = features?.monitor_snapshots
  if (!Array.isArray(raw)) return []
  return raw.filter((item) => item && typeof item === 'object') as MonitorSnapshot[]
}

export function mergeEntryFeaturesForOutcome(
  buyFeatures: Record<string, unknown> | null | undefined,
  closeFeatures: Record<string, unknown>,
): Record<string, unknown> {
  const buy = buyFeatures ?? {}
  const monitors =
    readMonitorSnapshotsFromFeatures(closeFeatures).length > 0
      ? readMonitorSnapshotsFromFeatures(closeFeatures)
      : readMonitorSnapshotsFromFeatures(buy)
  return {
    ...buy,
    ...closeFeatures,
    organic_score: buy.organic_score ?? closeFeatures.organic_score ?? null,
    top_holders_pct: buy.top_holders_pct ?? closeFeatures.top_holders_pct ?? null,
    token_age_hours: buy.token_age_hours ?? closeFeatures.token_age_hours ?? null,
    volume_at_entry: buy.volume_at_entry ?? closeFeatures.volume_at_entry ?? null,
    volume_5m: buy.volume_5m ?? closeFeatures.volume_5m ?? null,
    entry_mcap: buy.entry_mcap ?? closeFeatures.entry_mcap ?? null,
    entry_mcap_band: buy.entry_mcap_band ?? closeFeatures.entry_mcap_band ?? null,
    monitor_snapshots: monitors,
  }
}
