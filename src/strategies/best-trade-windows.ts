/** Best clock-hour trading windows from closed strategy outcomes (PnL). */

import type {
  StrategyBestTradeWindows,
  StrategyDomain,
  StrategyHourBucket,
  StrategyOutcomeRow,
  StrategyTradeWindow,
} from './types'

export const DEFAULT_REPORT_TIMEZONE = 'Asia/Bangkok'
export const REPORT_TIMEZONES = ['Asia/Bangkok', 'UTC'] as const
export type ReportTimeZone = (typeof REPORT_TIMEZONES)[number]

const WINDOW_HOURS = 4
const MIN_WINDOW_TRADES = 5
const MIN_STRATEGY_TRADES = 5
const TOP_WINDOWS = 3

export function resolveReportTimeZone(raw: string | null | undefined): string {
  const t = (raw ?? '').trim()
  if (!t) return DEFAULT_REPORT_TIMEZONE
  if (t === 'UTC' || t === 'Etc/UTC') return 'UTC'
  if (t === 'Asia/Bangkok') return 'Asia/Bangkok'
  try {
    // Validate IANA — throw if unsupported
    Intl.DateTimeFormat('en-US', { timeZone: t }).format(new Date())
    return t
  } catch {
    return DEFAULT_REPORT_TIMEZONE
  }
}

/** Local hour 0–23 in `timeZone` for an ISO timestamp. */
export function hourInTimeZone(iso: string, timeZone: string): number | null {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms))
    const hourPart = parts.find((p) => p.type === 'hour')?.value
    if (hourPart == null) return null
    const h = Number(hourPart)
    return Number.isFinite(h) ? ((h % 24) + 24) % 24 : null
  } catch {
    return null
  }
}

function emptyHours(): StrategyHourBucket[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    trade_count: 0,
    win_count: 0,
    win_rate: 0,
    avg_pnl_pct: 0,
    total_pnl_pct: 0,
  }))
}

function finalizeHours(hours: StrategyHourBucket[]): StrategyHourBucket[] {
  return hours.map((h) => ({
    ...h,
    win_rate: h.trade_count ? h.win_count / h.trade_count : 0,
    avg_pnl_pct: h.trade_count ? h.total_pnl_pct / h.trade_count : 0,
  }))
}

function scoreWindow(
  hours: StrategyHourBucket[],
  startHour: number,
): StrategyTradeWindow | null {
  let trade_count = 0
  let win_count = 0
  let total_pnl_pct = 0
  for (let i = 0; i < WINDOW_HOURS; i++) {
    const h = hours[(startHour + i) % 24]!
    trade_count += h.trade_count
    win_count += h.win_count
    total_pnl_pct += h.total_pnl_pct
  }
  if (trade_count < MIN_WINDOW_TRADES) return null
  return {
    start_hour: startHour,
    end_hour: (startHour + WINDOW_HOURS) % 24,
    trade_count,
    win_rate: win_count / trade_count,
    avg_pnl_pct: total_pnl_pct / trade_count,
    total_pnl_pct,
  }
}

function compareWindows(a: StrategyTradeWindow, b: StrategyTradeWindow): number {
  if (a.avg_pnl_pct !== b.avg_pnl_pct) return b.avg_pnl_pct - a.avg_pnl_pct
  return b.trade_count - a.trade_count
}

export function formatHourRangeLabel(
  startHour: number,
  endHour: number,
  timeZone: string,
): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const tzShort = timeZone === 'UTC' ? 'UTC' : timeZone.includes('Bangkok') ? 'Bangkok' : timeZone
  return `${pad(startHour)}:00–${pad(endHour)}:00 ${tzShort}`
}

export function computeBestTradeWindows(
  rows: StrategyOutcomeRow[],
  options?: { timeZone?: string },
): StrategyBestTradeWindows[] {
  const timeZone = resolveReportTimeZone(options?.timeZone)
  const groups = new Map<string, StrategyOutcomeRow[]>()

  for (const row of rows) {
    if (row.pnl_pct == null || !Number.isFinite(Number(row.pnl_pct))) continue
    const key = `${row.domain}|${row.strategy_id}|${row.is_simulated}`
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  }

  const out: StrategyBestTradeWindows[] = []

  for (const [key, groupRows] of Array.from(groups.entries())) {
    const [domain, strategy_id, simStr] = key.split('|')
    const hours = emptyHours()
    let timed = 0

    for (const row of groupRows) {
      const iso = row.entry_at || row.created_at
      if (!iso) continue
      const hour = hourInTimeZone(iso, timeZone)
      if (hour == null) continue
      const bucket = hours[hour]!
      const pnl = Number(row.pnl_pct)
      bucket.trade_count += 1
      bucket.total_pnl_pct += pnl
      if (pnl >= 0) bucket.win_count += 1
      timed += 1
    }

    const finalized = finalizeHours(hours)
    const windows: StrategyTradeWindow[] = []
    for (let start = 0; start < 24; start++) {
      const w = scoreWindow(finalized, start)
      if (w) windows.push(w)
    }
    windows.sort(compareWindows)

    const top_windows = timed >= MIN_STRATEGY_TRADES ? windows.slice(0, TOP_WINDOWS) : []
    const best = top_windows[0] ?? null

    out.push({
      strategy_id: strategy_id!,
      domain: domain as StrategyDomain,
      is_simulated: simStr === 'true',
      timezone: timeZone,
      best,
      top_windows,
      hours: finalized,
    })
  }

  out.sort((a, b) => {
    const aAvg = a.best?.avg_pnl_pct ?? -Infinity
    const bAvg = b.best?.avg_pnl_pct ?? -Infinity
    if (aAvg !== bAvg) return bAvg - aAvg
    return a.strategy_id.localeCompare(b.strategy_id)
  })

  return out
}
