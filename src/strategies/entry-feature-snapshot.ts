import { buildEntryMcapFeatures } from './outcome-features'
import { socialSnapshotToFeatureFields, type SocialSnapshot } from './social-snapshot'
import { filterPointsToWindow } from './trade-window-chart-data'
import type { OutcomeChartPoint } from './types'

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
  social?: SocialSnapshot | null
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
  if (input.social) {
    Object.assign(snapshot, socialSnapshotToFeatureFields(input.social))
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

export type MonitorChartPriceFallback = {
  initialPriceUsd?: number | null
  entryMcap?: number | null
}

export function monitorSnapshotsToChartPoints(
  snapshots: MonitorSnapshot[],
  entryAt: string,
  exitAt: string,
  priceFallback?: MonitorChartPriceFallback,
): OutcomeChartPoint[] {
  const start = new Date(entryAt).getTime()
  const end = new Date(exitAt).getTime()
  if (Number.isNaN(start) || Number.isNaN(end)) return []

  const initialPrice = priceFallback?.initialPriceUsd
  const entryMcap = priceFallback?.entryMcap
  const points: OutcomeChartPoint[] = []

  for (const snap of snapshots) {
    const t = new Date(snap.timestamp).getTime()
    if (Number.isNaN(t) || t < start || t > end) continue

    let price_usd: number | null = null
    if (typeof snap.price_usd === 'number' && Number.isFinite(snap.price_usd)) {
      price_usd = snap.price_usd
    } else if (
      typeof snap.market_cap === 'number' &&
      typeof entryMcap === 'number' &&
      typeof initialPrice === 'number' &&
      entryMcap > 0 &&
      Number.isFinite(snap.market_cap) &&
      Number.isFinite(initialPrice)
    ) {
      price_usd = initialPrice * (snap.market_cap / entryMcap)
    }

    if (price_usd == null) continue

    const volume_5m =
      typeof snap.volume_5m === 'number' && Number.isFinite(snap.volume_5m)
        ? snap.volume_5m
        : null

    points.push({ timestamp: snap.timestamp, price_usd, volume_5m })
  }

  return points.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  )
}

export function mergeMonitorSnapshots(
  existing: MonitorSnapshot[] | undefined,
  incoming: MonitorSnapshot[],
  max = 288,
): MonitorSnapshot[] {
  const byKey = new Map<string, MonitorSnapshot>()
  for (const snap of [...(existing ?? []), ...incoming]) {
    if (!snap?.timestamp) continue
    byKey.set(snap.timestamp, snap)
  }
  return Array.from(byKey.values())
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    )
    .slice(-max)
}

export function priceHistoryToMonitorSnapshots(
  points: OutcomeChartPoint[],
  entryAt: string,
  exitAt: string,
): MonitorSnapshot[] {
  return filterPointsToWindow(points, entryAt, exitAt).map((p) => ({
    timestamp: p.timestamp,
    price_usd: p.price_usd,
    volume_5m: p.volume_5m ?? null,
    market_cap: null,
  }))
}

export function enrichFeaturesWithMonitorSnapshots(
  features: Record<string, unknown>,
  snapshots: MonitorSnapshot[],
): Record<string, unknown> {
  if (snapshots.length === 0) return features
  const merged = mergeMonitorSnapshots(
    readMonitorSnapshotsFromFeatures(features),
    snapshots,
  )
  const next: Record<string, unknown> = {
    ...features,
    monitor_snapshots: merged,
  }
  if (next.volume_at_entry == null && merged[0]?.volume_5m != null) {
    next.volume_at_entry = merged[0].volume_5m
  }
  return next
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
