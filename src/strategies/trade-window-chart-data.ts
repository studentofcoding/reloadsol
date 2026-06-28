import type { OutcomeChartPoint, StrategyDomain } from './types'
import type { MonitorSnapshot } from './entry-feature-snapshot'

export function parsePriceHistory(raw: unknown): OutcomeChartPoint[] {
  if (!raw) return []
  let data = raw
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      return []
    }
  }
  if (!Array.isArray(data)) return []
  return data
    .filter(
      (p): p is Record<string, unknown> =>
        p != null &&
        typeof p === 'object' &&
        typeof (p as { timestamp?: unknown }).timestamp === 'string' &&
        typeof (p as { price_usd?: unknown }).price_usd === 'number',
    )
    .map((p) => {
      const point: OutcomeChartPoint = {
        timestamp: p.timestamp as string,
        price_usd: p.price_usd as number,
      }
      const volume5m = p.volume_5m
      const legacyVolume = p.volume
      if (typeof volume5m === 'number' && Number.isFinite(volume5m)) {
        point.volume_5m = volume5m
      } else if (typeof legacyVolume === 'number' && Number.isFinite(legacyVolume)) {
        point.volume_5m = legacyVolume
      }
      return point
    })
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    )
}

export function filterPointsToWindow(
  points: OutcomeChartPoint[],
  entryAt: string,
  exitAt: string,
): OutcomeChartPoint[] {
  const start = new Date(entryAt).getTime()
  const end = new Date(exitAt).getTime()
  if (Number.isNaN(start) || Number.isNaN(end)) return []
  return points.filter((p) => {
    const t = new Date(p.timestamp).getTime()
    return t >= start && t <= end
  })
}

export function countVolumePoints(points: OutcomeChartPoint[]): number {
  return points.filter(
    (p) => p.volume_5m != null && Number.isFinite(p.volume_5m),
  ).length
}

export function hasVolumeOnPoints(points: OutcomeChartPoint[]): boolean {
  return countVolumePoints(points) > 0
}

export function readVolumeFromFeatures(
  features: Record<string, unknown>,
): number | null {
  const poolVolume = features.pool_volume
  if (typeof poolVolume === 'number' && Number.isFinite(poolVolume)) {
    return poolVolume
  }
  const raw = features.volume_at_entry ?? features.volume_5m
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

export function lastSnapshotVolume(
  features: Record<string, unknown>,
): number | null {
  const raw = features.monitor_snapshots
  if (!Array.isArray(raw)) return null
  for (let i = raw.length - 1; i >= 0; i--) {
    const item = raw[i]
    if (!item || typeof item !== 'object') continue
    const vol = (item as MonitorSnapshot).volume_5m
    if (typeof vol === 'number' && Number.isFinite(vol)) return vol
  }
  return null
}

/** Nearest monitor snapshot volume by timestamp (within 10 min). */
export function mergeVolumeFromMonitorSnapshots(
  points: OutcomeChartPoint[],
  snapshots: MonitorSnapshot[],
): OutcomeChartPoint[] {
  if (snapshots.length === 0) return points
  const maxDeltaMs = 10 * 60 * 1000

  return points.map((point) => {
    if (point.volume_5m != null && Number.isFinite(point.volume_5m)) {
      return point
    }
    const pointMs = new Date(point.timestamp).getTime()
    if (Number.isNaN(pointMs)) return point

    let bestVol: number | null = null
    let bestDelta = Infinity
    for (const snap of snapshots) {
      const vol = snap.volume_5m
      if (vol == null || !Number.isFinite(vol)) continue
      const snapMs = new Date(snap.timestamp).getTime()
      if (Number.isNaN(snapMs)) continue
      const delta = Math.abs(snapMs - pointMs)
      if (delta <= maxDeltaMs && delta < bestDelta) {
        bestDelta = delta
        bestVol = vol
      }
    }
    if (bestVol == null) return point
    return { ...point, volume_5m: bestVol }
  })
}

export function trackerHistoryHasVolume(points: OutcomeChartPoint[]): boolean {
  return points.some((p) => p.volume_5m != null && Number.isFinite(p.volume_5m))
}

export function shouldUseTrackerHistoryFirst(domain: StrategyDomain): boolean {
  return domain === 'trending_bot' || domain === 'signals'
}

export function shouldSkipTrackerForDomain(domain: StrategyDomain): boolean {
  return domain === 'dlmm'
}
