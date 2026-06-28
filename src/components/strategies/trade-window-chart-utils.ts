import type { OutcomeChartPoint } from '@/strategies/types'

export const VOLUME_BAR_UP = '#10b981'
export const VOLUME_BAR_DOWN = '#ef4444'
export const VOLUME_BAR_NEUTRAL = '#6b7280'

export function hasVolumeData(points: OutcomeChartPoint[]): boolean {
  return points.some(
    (p) => p.volume_5m != null && Number.isFinite(p.volume_5m),
  )
}

export function volumeBarColors(points: OutcomeChartPoint[]): string[] {
  return points.map((point, index) => {
    const vol = point.volume_5m
    if (vol == null || !Number.isFinite(vol)) return VOLUME_BAR_NEUTRAL
    if (index === 0) return VOLUME_BAR_NEUTRAL
    const prev = points[index - 1]?.volume_5m
    if (prev == null || !Number.isFinite(prev)) return VOLUME_BAR_NEUTRAL
    if (vol > prev) return VOLUME_BAR_UP
    if (vol < prev) return VOLUME_BAR_DOWN
    return VOLUME_BAR_NEUTRAL
  })
}

export function formatVolume(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return Math.round(value).toString()
}
