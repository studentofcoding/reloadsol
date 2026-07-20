/** Pure window math for Potential / Rug OHLC label capture. */

export const POTENTIAL_MAX_MS = 10 * 60 * 1000

export type SignalOhlcLabelKind = 'potential' | 'rug'

export type SignalOhlcEndReason =
  | 'peak'
  | 'milestone_200'
  | 'milestone_120'
  | 'milestone_80'
  | 'cap_10m'
  | 'status_changed'
  | 'label_now'

export type PriceHistPoint = {
  timestamp?: string | number | null
  price_usd?: number | null
}

export type TrackContext = {
  tracking_started_at?: string | null
  waiting_started_at?: string | null
  first_seen_at?: string | null
  created_at?: string | null
  status_changed_at?: string | null
  when_reach_80pct?: string | null
  when_reach_120pct?: string | null
  when_reach_200pct?: string | null
  price_history?: PriceHistPoint[] | null
}

export type SignalOhlcWindow = {
  windowStartIso: string
  windowEndIso: string
  endReason: SignalOhlcEndReason
}

function parseMs(raw: unknown): number | null {
  if (raw == null) return null
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw * 1000
  }
  if (typeof raw === 'string' && raw.trim()) {
    const ms = new Date(raw).getTime()
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

export function hasTrackStartAnchor(ctx: TrackContext): boolean {
  return (
    parseMs(ctx.tracking_started_at) != null ||
    parseMs(ctx.waiting_started_at) != null ||
    parseMs(ctx.first_seen_at) != null ||
    parseMs(ctx.created_at) != null
  )
}

export function resolveTrackStartMs(ctx: TrackContext, nowMs = Date.now()): number {
  const candidates = [
    ctx.tracking_started_at,
    ctx.waiting_started_at,
    ctx.first_seen_at,
    ctx.created_at,
  ]
  for (const c of candidates) {
    const ms = parseMs(c)
    if (ms != null) return ms
  }
  return nowMs
}

/** Capture bounds for OHLC gallery: no tracker → last 10m ending now. */
export function resolveCaptureWindowMs(
  ctx: TrackContext,
  label: SignalOhlcLabelKind,
  nowMs = Date.now(),
): { startMs: number; endMs: number; endReason: SignalOhlcEndReason } {
  if (!hasTrackStartAnchor(ctx)) {
    return {
      startMs: nowMs - POTENTIAL_MAX_MS,
      endMs: nowMs,
      endReason: 'label_now',
    }
  }

  const w = resolveSignalOhlcWindow({ label, ctx, nowMs })
  let startMs = Date.parse(w.windowStartIso)
  let endMs = Date.parse(w.windowEndIso)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return {
      startMs: nowMs - POTENTIAL_MAX_MS,
      endMs: nowMs,
      endReason: 'label_now',
    }
  }
  // Never ask for a future window
  if (endMs > nowMs) endMs = nowMs
  if (endMs <= startMs) {
    return {
      startMs: nowMs - POTENTIAL_MAX_MS,
      endMs: nowMs,
      endReason: 'label_now',
    }
  }
  return { startMs, endMs, endReason: w.endReason }
}

/** Timestamp of max price_usd in price_history (within optional max). */
export function peakPriceTimestampMs(
  history: PriceHistPoint[] | null | undefined,
  startMs: number,
  maxEndMs: number,
): number | null {
  if (!Array.isArray(history) || history.length === 0) return null
  let bestPrice = -Infinity
  let bestTs: number | null = null
  for (const row of history) {
    const t = parseMs(row.timestamp)
    const p = row.price_usd
    if (t == null || p == null || !Number.isFinite(p)) continue
    if (t < startMs || t > maxEndMs) continue
    if (p > bestPrice) {
      bestPrice = p
      bestTs = t
    }
  }
  return bestTs
}

export function resolveSignalOhlcWindow(params: {
  label: SignalOhlcLabelKind
  ctx: TrackContext
  nowMs?: number
}): SignalOhlcWindow {
  const nowMs = params.nowMs ?? Date.now()
  const startMs = resolveTrackStartMs(params.ctx, nowMs)

  if (params.label === 'rug') {
    const stopMs = parseMs(params.ctx.status_changed_at)
    if (stopMs != null && stopMs >= startMs) {
      return {
        windowStartIso: new Date(startMs).toISOString(),
        windowEndIso: new Date(stopMs).toISOString(),
        endReason: 'status_changed',
      }
    }
    const endMs = Math.max(startMs, nowMs)
    return {
      windowStartIso: new Date(startMs).toISOString(),
      windowEndIso: new Date(endMs).toISOString(),
      endReason: 'label_now',
    }
  }

  // potential
  const capMs = startMs + POTENTIAL_MAX_MS
  const hardEnd = Math.min(nowMs, capMs)

  const peakTs = peakPriceTimestampMs(
    params.ctx.price_history,
    startMs,
    hardEnd,
  )
  if (peakTs != null) {
    return {
      windowStartIso: new Date(startMs).toISOString(),
      windowEndIso: new Date(Math.min(peakTs, hardEnd)).toISOString(),
      endReason: 'peak',
    }
  }

  const m200 = parseMs(params.ctx.when_reach_200pct)
  if (m200 != null && m200 >= startMs) {
    return {
      windowStartIso: new Date(startMs).toISOString(),
      windowEndIso: new Date(Math.min(m200, hardEnd)).toISOString(),
      endReason: 'milestone_200',
    }
  }
  const m120 = parseMs(params.ctx.when_reach_120pct)
  if (m120 != null && m120 >= startMs) {
    return {
      windowStartIso: new Date(startMs).toISOString(),
      windowEndIso: new Date(Math.min(m120, hardEnd)).toISOString(),
      endReason: 'milestone_120',
    }
  }
  const m80 = parseMs(params.ctx.when_reach_80pct)
  if (m80 != null && m80 >= startMs) {
    return {
      windowStartIso: new Date(startMs).toISOString(),
      windowEndIso: new Date(Math.min(m80, hardEnd)).toISOString(),
      endReason: 'milestone_80',
    }
  }

  return {
    windowStartIso: new Date(startMs).toISOString(),
    windowEndIso: new Date(hardEnd).toISOString(),
    endReason: 'cap_10m',
  }
}

/** Map UI / API label to storage label. */
export function toSignalOhlcStoreLabel(
  label: string,
): SignalOhlcLabelKind | null {
  if (label === 'potential') return 'potential'
  if (label === 'rug' || label === 'rugged') return 'rug'
  return null
}
