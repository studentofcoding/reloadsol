import type { TokenChartOutcomeSegment, TokenOhlcBar } from '@/strategies/token-map-chart'
import { DOMAIN_COLORS } from '@/strategies/token-map-strategy-chart-paint'
import type {
  TokenMapActivityItem,
  TokenMapDomain,
} from '@/strategies/token-map-types'

export const OPEN_MARKER = '#34d399'
export const CLOSE_MARKER = '#f87171'

export type MarkerRole = 'open' | 'close' | 'signal'

export type ChartMarker = {
  time: number
  role: MarkerRole
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square'
  position: 'aboveBar' | 'belowBar' | 'inBar'
  color: string
  size: number
  text?: string
}

export function candleIntervalSec(candles: TokenOhlcBar[]): number {
  if (candles.length < 2) return 60
  const gaps: number[] = []
  for (let i = 1; i < Math.min(candles.length, 40); i++) {
    const d = candles[i]!.time - candles[i - 1]!.time
    if (d > 0) gaps.push(d)
  }
  if (gaps.length === 0) return 60
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)]! || 60
}

function shortStrategyLabel(title: string): string | undefined {
  const part = title.includes('·')
    ? title.split('·').pop()?.trim()
    : title.trim()
  if (!part) return undefined
  return part.length > 12 ? `${part.slice(0, 11)}…` : part
}

function activityToMarker(item: TokenMapActivityItem): ChartMarker | null {
  const ms = new Date(item.occurredAt).getTime()
  if (!Number.isFinite(ms)) return null
  const time = Math.floor(ms / 1000)
  const color = DOMAIN_COLORS[item.domain] ?? '#94a3b8'

  if (item.kind === 'sim_open') {
    const label = shortStrategyLabel(item.title)
    return {
      time,
      role: 'open',
      shape: 'arrowUp',
      position: 'belowBar',
      color: OPEN_MARKER,
      size: 1,
      ...(label ? { text: label } : {}),
    }
  }
  if (item.kind === 'sim_close') {
    return {
      time,
      role: 'close',
      shape: 'arrowDown',
      position: 'aboveBar',
      color: CLOSE_MARKER,
      size: 1.1,
    }
  }
  if (item.kind === 'outcome') return null
  if (
    item.kind === 'gmgn_hot' ||
    item.kind === 'live_boost' ||
    item.kind === 'social_event'
  ) {
    return {
      time,
      role: 'signal',
      shape: 'circle',
      position: 'inBar',
      color,
      size: 1,
    }
  }
  return {
    time,
    role: 'signal',
    shape: 'circle',
    position: 'inBar',
    color,
    size: 1,
  }
}

function outcomeToMarkers(seg: TokenChartOutcomeSegment): ChartMarker[] {
  const out: ChartMarker[] = []
  if (seg.entryAt) {
    const t = Math.floor(new Date(seg.entryAt).getTime() / 1000)
    if (Number.isFinite(t)) {
      const id =
        seg.strategyId.length > 12
          ? `${seg.strategyId.slice(0, 11)}…`
          : seg.strategyId
      out.push({
        time: t,
        role: 'open',
        shape: 'arrowUp',
        position: 'belowBar',
        color: OPEN_MARKER,
        size: 1,
        text: `in ${id}`,
      })
    }
  }
  if (seg.exitAt) {
    const t = Math.floor(new Date(seg.exitAt).getTime() / 1000)
    if (Number.isFinite(t)) {
      const lost = (seg.status ?? '').toLowerCase() === 'lost'
      out.push({
        time: t,
        role: 'close',
        shape: lost ? 'arrowDown' : 'square',
        position: 'aboveBar',
        color: CLOSE_MARKER,
        size: 1.1,
        text:
          seg.pnlPct != null
            ? `${seg.pnlPct.toFixed(1)}%`
            : seg.status ?? 'out',
      })
    }
  }
  return out
}

/** Collapse markers in the same candle bucket to one open, one close, one signal. */
export function collapseMarkers(
  markers: ChartMarker[],
  intervalSec: number,
): ChartMarker[] {
  const step = Math.max(1, Math.floor(intervalSec))
  type Bucket = {
    open?: ChartMarker
    close?: ChartMarker
    signals: ChartMarker[]
  }
  const buckets = new Map<number, Bucket>()

  for (const m of markers) {
    const key = Math.floor(m.time / step) * step
    let b = buckets.get(key)
    if (!b) {
      b = { signals: [] }
      buckets.set(key, b)
    }
    if (m.role === 'open') {
      if (!b.open || m.time >= b.open.time) b.open = { ...m, time: key }
    } else if (m.role === 'close') {
      if (!b.close || m.time >= b.close.time) b.close = { ...m, time: key }
    } else {
      b.signals.push({ ...m, time: key })
    }
  }

  const out: ChartMarker[] = []
  const keys = Array.from(buckets.keys()).sort((a, b) => a - b)
  for (const key of keys) {
    const b = buckets.get(key)!
    if (b.open) out.push(b.open)
    if (b.close) {
      out.push(b.close)
    }
    if (b.signals.length > 0) {
      const first = b.signals[0]!
      const n = b.signals.length
      out.push({
        ...first,
        time: key,
        position: b.close ? 'inBar' : 'aboveBar',
        ...(n > 1 ? { text: `×${n}` } : { text: undefined }),
      })
    }
  }
  return out
}

export function buildTidiedMarkers(params: {
  activities: TokenMapActivityItem[]
  outcomes: TokenChartOutcomeSegment[]
  enabled: ReadonlySet<TokenMapDomain>
  intervalSec?: number
}): ChartMarker[] {
  const raw: ChartMarker[] = []
  for (const item of params.activities) {
    if (!params.enabled.has(item.domain)) continue
    const m = activityToMarker(item)
    if (m) raw.push(m)
  }
  for (const seg of params.outcomes) {
    if (!params.enabled.has(seg.domain)) continue
    raw.push(...outcomeToMarkers(seg))
  }
  return collapseMarkers(raw, params.intervalSec ?? 60)
}
