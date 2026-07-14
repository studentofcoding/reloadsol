/**
 * 2h mint accumulator: merge poll snapshot with prior social_token_events peaks.
 * Pure — callers load events; this only merges.
 */

export const RADAR_ACCUMULATE_WINDOW_MS = 2 * 60 * 60 * 1000

export type RadarPollSnapshot = {
  sm: number
  kol: number
  activityScore?: number
}

export type RadarAccumulated = {
  smPeak: number
  kolPeak: number
  activityScorePeak: number
  earlySignalsScore: number | null
  earlyGrowthPct: number | null
  hasEarlyEnter: boolean
}

function readMetaNum(meta: Record<string, unknown>, key: string): number {
  const v = meta[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return 0
}

function readMetaNumOrNull(meta: Record<string, unknown>, key: string): number | null {
  const v = meta[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

export type SocialEventLike = {
  source?: string | null
  event_type?: string | null
  occurred_at?: string | null
  raw_metadata?: Record<string, unknown> | null
}

/** Merge current poll with events in the last `windowMs` (default 2h). */
export function accumulateRadarPeaks(params: {
  poll: RadarPollSnapshot
  events: SocialEventLike[]
  now?: Date
  windowMs?: number
}): RadarAccumulated {
  const now = params.now ?? new Date()
  const windowMs = params.windowMs ?? RADAR_ACCUMULATE_WINDOW_MS
  const cutoff = now.getTime() - windowMs

  let smPeak = Math.max(0, params.poll.sm)
  let kolPeak = Math.max(0, params.poll.kol)
  let activityScorePeak = Math.max(0, params.poll.activityScore ?? 0)
  let earlySignalsScore: number | null = null
  let earlyGrowthPct: number | null = null
  let hasEarlyEnter = false

  for (const event of params.events) {
    const ms = new Date(String(event.occurred_at ?? '')).getTime()
    if (!Number.isFinite(ms) || ms < cutoff) continue

    const meta =
      event.raw_metadata && typeof event.raw_metadata === 'object'
        ? event.raw_metadata
        : {}
    const source = String(event.source ?? '')
    const eventType = String(event.event_type ?? '')

    if (source.startsWith('gmgn_') && eventType === 'wallet_buy') {
      smPeak = Math.max(
        smPeak,
        readMetaNum(meta, 'sm_wallet_count_60m'),
        readMetaNum(meta, 'radar_sm_peak'),
      )
      kolPeak = Math.max(
        kolPeak,
        readMetaNum(meta, 'kol_wallet_count_60m'),
        readMetaNum(meta, 'radar_kol_peak'),
      )
      activityScorePeak = Math.max(
        activityScorePeak,
        readMetaNum(meta, 'gmgn_activity_score'),
      )
    }

    if (source === 'signals_early' || eventType === 'early_enter') {
      hasEarlyEnter = true
      const score =
        readMetaNumOrNull(meta, 'early_signals_score') ??
        readMetaNumOrNull(meta, 'score')
      const growth =
        readMetaNumOrNull(meta, 'early_growth_pct') ??
        readMetaNumOrNull(meta, 'growth_percent')
      if (score != null) {
        earlySignalsScore =
          earlySignalsScore == null ? score : Math.max(earlySignalsScore, score)
      }
      if (growth != null) {
        earlyGrowthPct =
          earlyGrowthPct == null ? growth : Math.max(earlyGrowthPct, growth)
      }
    }
  }

  return {
    smPeak,
    kolPeak,
    activityScorePeak,
    earlySignalsScore,
    earlyGrowthPct,
    hasEarlyEnter,
  }
}

/** SM/KOL peaks from recent social events for a mint (for copy-trade alerts). */
export async function lookupSmKolPeaksForMint(
  tokenAddress: string,
  limit = 30,
): Promise<{ sm: number; kol: number } | null> {
  try {
    const { fetchRecentSocialEvents } = await import('./social/db')
    const events = await fetchRecentSocialEvents(tokenAddress, limit)
    if (!events.length) return null
    const peaks = accumulateRadarPeaks({
      poll: { sm: 0, kol: 0 },
      events,
    })
    if (peaks.smPeak <= 0 && peaks.kolPeak <= 0) return null
    return { sm: peaks.smPeak, kol: peaks.kolPeak }
  } catch {
    return null
  }
}
