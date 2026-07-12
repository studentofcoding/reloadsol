import type { StrategyDomain, StrategyOutcomeRow } from './types'

export type MistakePhase = 'entry' | 'management' | 'exit'

export type ReviewTag = {
  key: string
  label: string
  phase?: MistakePhase
}

export type WeekBucket = {
  weekKey: string
  tradeCount: number
  winCount: number
  lossCount: number
  avgPnlPct: number
  totalPnlPct: number
  tags: Record<string, number>
}

export type StreakFlag = {
  tag: string
  weeks: string[]
  length: number
}

export type StrategyScorecard = {
  strategyId: string
  domain: StrategyDomain
  monthKey: string
  tradeCount: number
  totalPnlPct: number
  winRate: number
}

export type StrategyReviewPayload = {
  weeks: WeekBucket[]
  punchCard: { tags: string[]; weeks: string[]; counts: number[][] }
  streaks: StreakFlag[]
  scorecard: {
    best: StrategyScorecard[]
    worst: StrategyScorecard[]
  }
  periodSummary: {
    from: string
    to: string
    tradeCount: number
    winRate: number
    avgPnlPct: number
    totalPnlPct: number
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** ISO week key YYYY-Www in UTC (ponytail: UTC is fine for bucketing). */
export function isoWeekKey(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${pad2(week)}`
}

export function monthKey(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`
}

export function mistakePhaseFromOutcome(row: StrategyOutcomeRow): MistakePhase {
  const status = String(row.status ?? '').toLowerCase()
  const features = row.features ?? {}
  const reason = String(
    features.exit_reason ?? features.close_reason ?? features.exit_trigger ?? status,
  ).toLowerCase()

  if (/honeypot|security|gate|reject|filter|entry.?ml|bad.?entry|skip/.test(reason)) {
    return 'entry'
  }
  if (/trail|partial|timeout|time.?stop|management|hold/.test(reason)) {
    return 'management'
  }
  if (/tp|take.?profit|sl|stop.?loss|sell|exit|completed|won|lost/.test(reason)) {
    return 'exit'
  }

  // Short hold + heavy loss ≈ entry mistake
  if (
    row.pnl_pct != null &&
    row.pnl_pct < -25 &&
    row.entry_at &&
    row.exit_at
  ) {
    const holdMs =
      new Date(row.exit_at).getTime() - new Date(row.entry_at).getTime()
    if (Number.isFinite(holdMs) && holdMs < 30 * 60 * 1000) return 'entry'
  }

  return 'exit'
}

export function tagsForOutcome(row: StrategyOutcomeRow): string[] {
  const tags = [`setup:${row.domain}/${row.strategy_id}`]
  if (row.status) tags.push(`status:${row.status}`)
  const pnl = row.pnl_pct
  if (pnl != null && pnl < 0) {
    const phase = mistakePhaseFromOutcome(row)
    tags.push(`phase:${phase}`)
    tags.push(`loss:${row.domain}/${row.strategy_id}`)
  }
  return tags
}

function listRecentWeekKeys(count: number, now = new Date()): string[] {
  const keys: string[] = []
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  for (let i = 0; i < count * 7; i += 7) {
    const t = new Date(d)
    t.setUTCDate(t.getUTCDate() - i)
    const key = isoWeekKey(t.toISOString())
    if (key && !keys.includes(key)) keys.push(key)
  }
  return keys.reverse()
}

export function buildStrategyReview(
  rows: StrategyOutcomeRow[],
  options?: { weeks?: number; now?: Date },
): StrategyReviewPayload {
  const weekCount = options?.weeks ?? 12
  const now = options?.now ?? new Date()
  const weekKeys = listRecentWeekKeys(weekCount, now)
  const weekSet = new Set(weekKeys)

  const byWeek = new Map<string, StrategyOutcomeRow[]>()
  for (const key of weekKeys) byWeek.set(key, [])

  for (const row of rows) {
    const at = row.exit_at ?? row.created_at
    if (!at) continue
    const wk = isoWeekKey(at)
    if (!wk || !weekSet.has(wk)) continue
    byWeek.get(wk)!.push(row)
  }

  const weeks: WeekBucket[] = weekKeys.map((weekKey) => {
    const group = byWeek.get(weekKey) ?? []
    const pnls = group
      .map((r) => r.pnl_pct)
      .filter((v): v is number => v != null && Number.isFinite(v))
    const wins = pnls.filter((p) => p >= 0).length
    const tags: Record<string, number> = {}
    for (const row of group) {
      for (const tag of tagsForOutcome(row)) {
        tags[tag] = (tags[tag] ?? 0) + 1
      }
    }
    return {
      weekKey,
      tradeCount: group.length,
      winCount: wins,
      lossCount: pnls.length - wins,
      avgPnlPct: pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0,
      totalPnlPct: pnls.reduce((a, b) => a + b, 0),
      tags,
    }
  })

  // Punch card: loss/phase/setup tags with any presence
  const tagTotals = new Map<string, number>()
  for (const w of weeks) {
    for (const [tag, n] of Object.entries(w.tags)) {
      if (!tag.startsWith('loss:') && !tag.startsWith('phase:') && !tag.startsWith('setup:')) {
        continue
      }
      tagTotals.set(tag, (tagTotals.get(tag) ?? 0) + n)
    }
  }
  const tags = Array.from(tagTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([t]) => t)

  const counts = tags.map((tag) =>
    weeks.map((w) => w.tags[tag] ?? 0),
  )

  // Streaks: loss:* or phase:* present 2+ consecutive weeks
  const streakCandidates = tags.filter(
    (t) => t.startsWith('loss:') || t.startsWith('phase:'),
  )
  const streaks: StreakFlag[] = []
  for (const tag of streakCandidates) {
    let run: string[] = []
    const flush = () => {
      if (run.length >= 2) {
        streaks.push({ tag, weeks: [...run], length: run.length })
      }
      run = []
    }
    for (const w of weeks) {
      if ((w.tags[tag] ?? 0) > 0) run.push(w.weekKey)
      else flush()
    }
    flush()
  }
  streaks.sort((a, b) => b.length - a.length)

  // Monthly scorecard by strategy
  const monthMap = new Map<string, StrategyOutcomeRow[]>()
  for (const row of rows) {
    const at = row.exit_at ?? row.created_at
    if (!at) continue
    const mk = monthKey(at)
    if (!mk) continue
    const key = `${mk}|${row.domain}|${row.strategy_id}`
    const list = monthMap.get(key) ?? []
    list.push(row)
    monthMap.set(key, list)
  }

  const scoreRows: StrategyScorecard[] = []
  for (const [key, group] of Array.from(monthMap.entries())) {
    const [mk, domain, strategyId] = key.split('|')
    const pnls = group
      .map((r) => r.pnl_pct)
      .filter((v): v is number => v != null && Number.isFinite(v))
    if (pnls.length === 0) continue
    const wins = pnls.filter((p) => p >= 0).length
    scoreRows.push({
      strategyId,
      domain: domain as StrategyDomain,
      monthKey: mk,
      tradeCount: pnls.length,
      totalPnlPct: pnls.reduce((a, b) => a + b, 0),
      winRate: wins / pnls.length,
    })
  }
  scoreRows.sort((a, b) => b.totalPnlPct - a.totalPnlPct)

  const allPnls = rows
    .map((r) => r.pnl_pct)
    .filter((v): v is number => v != null && Number.isFinite(v))
  const from = weeks[0]?.weekKey ?? ''
  const to = weeks[weeks.length - 1]?.weekKey ?? ''

  return {
    weeks,
    punchCard: { tags, weeks: weekKeys, counts },
    streaks: streaks.slice(0, 20),
    scorecard: {
      best: scoreRows.filter((r) => r.tradeCount >= 3).slice(0, 5),
      worst: [...scoreRows]
        .filter((r) => r.tradeCount >= 3)
        .sort((a, b) => a.totalPnlPct - b.totalPnlPct)
        .slice(0, 5),
    },
    periodSummary: {
      from,
      to,
      tradeCount: allPnls.length,
      winRate: allPnls.length
        ? allPnls.filter((p) => p >= 0).length / allPnls.length
        : 0,
      avgPnlPct: allPnls.length
        ? allPnls.reduce((a, b) => a + b, 0) / allPnls.length
        : 0,
      totalPnlPct: allPnls.reduce((a, b) => a + b, 0),
    },
  }
}

/** Deterministic “analyze” — no LLM required. */
export function heuristicReviewPatterns(
  review: StrategyReviewPayload,
  notesByWeek?: Record<string, string>,
): string[] {
  const patterns: string[] = []

  for (const s of review.streaks.slice(0, 5)) {
    patterns.push(
      `Active streak: ${s.tag} for ${s.length} weeks (${s.weeks[0]} → ${s.weeks[s.weeks.length - 1]}).`,
    )
  }

  if (review.scorecard.worst[0]) {
    const w = review.scorecard.worst[0]
    patterns.push(
      `Worst setup this window: ${w.domain}/${w.strategyId} in ${w.monthKey} (net ${w.totalPnlPct.toFixed(1)}% over ${w.tradeCount} trades).`,
    )
  }
  if (review.scorecard.best[0]) {
    const b = review.scorecard.best[0]
    patterns.push(
      `Best setup this window: ${b.domain}/${b.strategyId} in ${b.monthKey} (net ${b.totalPnlPct.toFixed(1)}%).`,
    )
  }

  // Plan vs behavior: note mentions a strategy id but losses continue on that setup
  if (notesByWeek) {
    for (const [week, note] of Object.entries(notesByWeek)) {
      const lower = note.toLowerCase()
      for (const s of review.streaks) {
        const id = s.tag.replace(/^loss:/, '')
        if (!id.includes('/')) continue
        const shortId = id.split('/')[1]
        if (
          shortId &&
          lower.includes(shortId.toLowerCase()) &&
          /(cut|reduce|stop|avoid|size)/.test(lower)
        ) {
          const later = review.streaks.find(
            (x) => x.tag === s.tag && x.weeks.some((w) => w > week),
          )
          if (later) {
            patterns.push(
              `Plan vs behavior: in ${week} you planned to curb ${shortId}, but ${s.tag} kept streaking (${later.weeks.join(', ')}).`,
            )
          }
        }
      }
    }
  }

  if (patterns.length === 0) {
    patterns.push('Not enough closed outcomes in this window to spot streaks yet.')
  }

  return patterns.slice(0, 5)
}
