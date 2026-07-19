import type { TokenChartOutcomeSegment, TokenOhlcBar } from '@/strategies/token-map-chart'
import type { TokenMapDomain } from '@/strategies/token-map-types'

export const DOMAIN_COLORS: Record<TokenMapDomain, string> = {
  mcap_tracker: '#a78bfa',
  signals: '#60a5fa',
  gmgn: '#facc15',
  trending_bot: '#34d399',
  dlmm: '#f472b6',
  social: '#94a3b8',
  infra: '#64748b',
}

/** Higher index wins when windows overlap. */
export const DOMAIN_PAINT_PRIORITY: TokenMapDomain[] = [
  'social',
  'dlmm',
  'trending_bot',
  'gmgn',
  'signals',
  'mcap_tracker',
]

export const GRAY_CANDLE = '#6b7280'
export const GRAY_WICK = '#4b5563'
export const CHART_TZ = 'Asia/Bangkok'

export type DomainWindow = {
  domain: TokenMapDomain
  startSec: number
  endSec: number
}

export function priceFormatFor(price: number): {
  type: 'price'
  precision: number
  minMove: number
} {
  const abs = Math.abs(price)
  if (!Number.isFinite(abs) || abs === 0) {
    return { type: 'price', precision: 8, minMove: 1e-8 }
  }
  if (abs >= 1) return { type: 'price', precision: 4, minMove: 0.0001 }
  if (abs >= 0.01) return { type: 'price', precision: 6, minMove: 1e-6 }
  if (abs >= 1e-4) return { type: 'price', precision: 8, minMove: 1e-8 }
  if (abs >= 1e-6) return { type: 'price', precision: 10, minMove: 1e-10 }
  return { type: 'price', precision: 12, minMove: 1e-12 }
}

export function formatPriceLabel(price: number): string {
  if (!Number.isFinite(price)) return '—'
  const abs = Math.abs(price)
  if (abs === 0) return '0'
  if (abs >= 1) return price.toFixed(4)
  if (abs >= 0.01) return price.toFixed(6)
  if (abs >= 1e-4) return price.toFixed(8)
  return price.toExponential(3)
}

export function outcomeWindows(
  outcomes: TokenChartOutcomeSegment[],
  enabled: ReadonlySet<TokenMapDomain>,
  nowSec = Math.floor(Date.now() / 1000),
): DomainWindow[] {
  const out: DomainWindow[] = []
  for (const seg of outcomes) {
    if (!enabled.has(seg.domain)) continue
    if (!seg.entryAt) continue
    const start = Math.floor(new Date(seg.entryAt).getTime() / 1000)
    if (!Number.isFinite(start)) continue
    let end = nowSec
    if (seg.exitAt) {
      const e = Math.floor(new Date(seg.exitAt).getTime() / 1000)
      if (Number.isFinite(e)) end = e
    }
    if (end < start) continue
    out.push({ domain: seg.domain, startSec: start, endSec: end })
  }
  return out
}

export function domainAtTime(
  t: number,
  windows: DomainWindow[],
): TokenMapDomain | null {
  let best: TokenMapDomain | null = null
  let bestRank = -1
  for (const w of windows) {
    if (t < w.startSec || t > w.endSec) continue
    const rank = DOMAIN_PAINT_PRIORITY.indexOf(w.domain)
    if (rank > bestRank) {
      bestRank = rank
      best = w.domain
    }
  }
  return best
}

export type PaintedCandle = {
  time: number
  open: number
  high: number
  low: number
  close: number
  color: string
  wickColor: string
  borderColor: string
}

export function paintCandles(
  candles: TokenOhlcBar[],
  windows: DomainWindow[],
): PaintedCandle[] {
  return candles.map((c) => {
    const domain = domainAtTime(c.time, windows)
    const color = domain ? DOMAIN_COLORS[domain] : GRAY_CANDLE
    const wickColor = domain ? DOMAIN_COLORS[domain] : GRAY_WICK
    return {
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      color,
      wickColor,
      borderColor: color,
    }
  })
}

function presenceMinutes(windows: DomainWindow[]): Set<number> {
  const set = new Set<number>()
  for (const w of windows) {
    const startM = Math.floor(w.startSec / 60)
    const endM = Math.floor(w.endSec / 60)
    for (let m = startM; m <= endM; m++) set.add(m)
  }
  return set
}

function jaccard(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  a.forEach((x) => {
    if (b.has(x)) inter++
  })
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * Mean pairwise Jaccard of enabled domains' windows.
 * Returns null when no pair has temporal overlap.
 */
export function meanPairwiseOverlapCorr(
  outcomes: TokenChartOutcomeSegment[],
  enabled: ReadonlySet<TokenMapDomain>,
  nowSec = Math.floor(Date.now() / 1000),
): number | null {
  const byDomain = new Map<TokenMapDomain, DomainWindow[]>()
  for (const w of outcomeWindows(outcomes, enabled, nowSec)) {
    const list = byDomain.get(w.domain) ?? []
    list.push(w)
    byDomain.set(w.domain, list)
  }
  const domains = Array.from(byDomain.keys())
  if (domains.length < 2) return null

  const sets = domains.map((d) => presenceMinutes(byDomain.get(d)!))
  const scores: number[] = []
  let anyOverlap = false
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i]!
      const b = sets[j]!
      let inter = 0
      a.forEach((x) => {
        if (b.has(x)) inter++
      })
      if (inter > 0) anyOverlap = true
      scores.push(jaccard(a, b))
    }
  }
  if (!anyOverlap || scores.length === 0) return null
  return scores.reduce((s, n) => s + n, 0) / scores.length
}
