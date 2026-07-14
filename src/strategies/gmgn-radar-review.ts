/** GMGN metrics → Radar review (WATCH / SKIP / ENTER). Recalibrated 0–100 scale. */

export type GmgnRadarAction = 'ENTER' | 'WATCH' | 'SKIP'

export type GmgnRadarInput = {
  sm: number
  kol: number
  holders?: number | null
  /** Top-10 share as percent (14) or fraction (0.14). */
  top10?: number | null
  top10Source?: 'gmgn' | 'jupiter' | null
  /** @deprecated not scored — kept for callers that still pass it */
  taxPct?: number | null
  honeypot?: boolean | null
  /** @deprecated not scored */
  liquidityUsd?: number | null
  buySellReturnPct?: number | null
  activityScore?: number | null
  earlySignalsScore?: number | null
  earlyGrowthPct?: number | null
  symbol?: string | null
  tokenAddress?: string
  category?: string | null
}

export type GmgnRadarReview = {
  action: GmgnRadarAction
  score: number
  emoji: string
  summary: string
  gmgnLine: string
  reasons: string[]
  top10Source?: 'gmgn' | 'jupiter' | null
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

export function normalizeTop10Pct(top10: number | null | undefined): number | null {
  if (top10 == null || !Number.isFinite(top10)) return null
  if (top10 > 0 && top10 <= 1) return top10 * 100
  return top10
}

/** Quality sub-score ∈ [-25, 20] from holders / top10 / buy-sell return only. */
function qualityPoints(input: GmgnRadarInput): number {
  let q = 0
  const holders = input.holders
  if (holders != null && holders > 0) {
    q += Math.min(Math.log10(holders + 1) * 4, 8)
  }

  const top10 = normalizeTop10Pct(input.top10)
  if (top10 != null) {
    if (top10 <= 12) q += 8
    else if (top10 <= 20) q += 4
    else if (top10 <= 35) q -= 10
    else q -= 20
  }

  const ret = input.buySellReturnPct
  if (ret != null) {
    if (ret >= 95) q += 4
    else if (ret < 80) q -= 15
  }

  return clamp(q, -25, 20)
}

/**
 * Point budget (then clamp 0–100):
 * base 10 + SM≤25 + KOL≤15 + activity≤35 + early≤20 + quality≤20
 */
export function scoreGmgnRadar(input: GmgnRadarInput): number {
  if (input.honeypot) return 10

  const sm = Math.max(0, input.sm)
  const kol = Math.max(0, input.kol)
  const activity = Math.max(0, input.activityScore ?? 0)
  const earlyScore = input.earlySignalsScore
  const earlyGrowth = input.earlyGrowthPct

  let score = 10
  // SM: min(sm,10)*2.5 → SM6=15, SM10=25
  score += Math.min(sm, 10) * 2.5
  // KOL: min(kol,10)*1.5 → max 15
  score += Math.min(kol, 10) * 1.5
  // Activity 0→200 → 0→35
  score += (Math.min(activity, 200) / 200) * 35

  if (earlyScore != null && earlyScore >= 50) score += 20
  else if (earlyGrowth != null && earlyGrowth >= 20) score += 8

  score += qualityPoints(input)

  const hasEarly =
    (earlyScore != null && earlyScore >= 50) ||
    (earlyGrowth != null && earlyGrowth >= 20)
  if (sm <= 0 && kol <= 0 && !hasEarly) {
    score = Math.min(score, 35)
  }

  return Math.round(clamp(score, 0, 100))
}

export function actionFromRadarScore(score: number): GmgnRadarAction {
  if (score >= 78) return 'ENTER'
  if (score >= 45) return 'WATCH'
  return 'SKIP'
}

export function actionEmoji(action: GmgnRadarAction): string {
  if (action === 'ENTER') return '🟢'
  if (action === 'WATCH') return '🟡'
  return '🔴'
}

/** Override action (e.g. price rules) and keep emoji/summary in sync. */
export function withRadarActionOverride(
  review: GmgnRadarReview,
  action: GmgnRadarAction,
  summaryExtra?: string | null,
): GmgnRadarReview {
  const summary =
    summaryExtra && summaryExtra.trim()
      ? `${summaryExtra.trim()} — ${review.summary}`
      : review.summary
  return {
    ...review,
    action,
    emoji: actionEmoji(action),
    summary,
  }
}

function hasHardRisk(input: GmgnRadarInput): boolean {
  if (input.honeypot) return true
  const top10 = normalizeTop10Pct(input.top10)
  if (top10 != null && top10 > 35) return true
  if (input.buySellReturnPct != null && input.buySellReturnPct < 80) return true
  return false
}

function buildReasons(input: GmgnRadarInput): string[] {
  const reasons: string[] = []
  if (input.honeypot) {
    reasons.push('honeypot risk')
    return reasons
  }
  if (input.honeypot === false) reasons.push('no honeypot')

  const top10 = normalizeTop10Pct(input.top10)
  if (top10 != null) {
    if (top10 <= 15) reasons.push('moderate holder spread')
    else if (top10 <= 25) reasons.push('moderate holder concentration')
    else reasons.push('high holder concentration')
  }

  if (input.sm > 0 && input.kol > 0) reasons.push('SM+KOL overlap')
  else if (input.sm > 0) reasons.push('smart money present')
  else if (input.kol > 0) reasons.push('KOL interest only')
  else reasons.push('no smart money')

  if (input.activityScore != null && input.activityScore >= 50) {
    reasons.push('hot activity')
  }
  if (input.earlySignalsScore != null && input.earlySignalsScore >= 50) {
    reasons.push('early signals enter')
  }

  const ret = input.buySellReturnPct
  if (ret != null && ret < 90) reasons.push('high slippage')

  if (input.holders != null && input.holders < 1500 && input.sm <= 0) {
    reasons.push('thin holder base')
  }

  return reasons
}

function summarize(action: GmgnRadarAction, reasons: string[], input: GmgnRadarInput): string {
  if (reasons.length === 0) {
    return action === 'SKIP'
      ? 'Insufficient confirmation — monitor.'
      : 'Limited signal — monitor before sizing up.'
  }

  // SKIP without hard risk: don't frame bullish SM/KOL as "too risky"
  if (action === 'SKIP' && !hasHardRisk(input)) {
    const soft = reasons.filter(
      (r) =>
        r !== 'smart money present' &&
        r !== 'KOL interest only' &&
        r !== 'SM+KOL overlap',
    )
    if (soft.length === 0) {
      return 'Insufficient confirmation — SM/KOL alone not enough yet.'
    }
    return `${soft.join(', ')} — insufficient confirmation.`
  }

  const body = reasons.join(', ')
  if (action === 'SKIP') return `${body} – too risky.`
  if (action === 'ENTER') return `${body} — setup looks actionable.`
  return `${body}—monitor before adding size.`
}

export function buildGmgnRadarReview(input: GmgnRadarInput): GmgnRadarReview {
  const score = scoreGmgnRadar(input)
  const action = actionFromRadarScore(score)
  const reasons = buildReasons(input)
  const top10 = normalizeTop10Pct(input.top10)
  const hold = input.holders != null ? String(Math.round(input.holders)) : '—'
  const top10Src =
    top10 != null && input.top10Source === 'jupiter'
      ? `${top10.toFixed(0)}% (jup)`
      : top10 != null
        ? `${top10.toFixed(0)}%`
        : '—'

  return {
    action,
    score,
    emoji: actionEmoji(action),
    summary: summarize(action, reasons, input),
    gmgnLine: `SM ${input.sm} · KOL ${input.kol} · hold ${hold} · top10 ${top10Src}`,
    reasons,
    top10Source: input.top10Source ?? null,
  }
}

/** Resolve top10: GMGN feature first, else Jupiter percent. */
export function resolveRadarTop10(params: {
  gmgnTop10?: number | null
  jupiterTop10Pct?: number | null
}): { top10: number | null; top10Source: 'gmgn' | 'jupiter' | null } {
  const gmgn = params.gmgnTop10
  if (gmgn != null && Number.isFinite(gmgn)) {
    return { top10: gmgn, top10Source: 'gmgn' }
  }
  const jup = params.jupiterTop10Pct
  if (jup != null && Number.isFinite(jup)) {
    return { top10: jup, top10Source: 'jupiter' }
  }
  return { top10: null, top10Source: null }
}

/** Map security-gate feature bag + activity / early into radar input. */
export function gmgnRadarInputFromFeatures(params: {
  sm: number
  kol: number
  features?: Record<string, unknown>
  activityScore?: number | null
  earlySignalsScore?: number | null
  earlyGrowthPct?: number | null
  jupiterTop10Pct?: number | null
}): GmgnRadarInput {
  const f = params.features ?? {}
  const num = (k: string): number | null => {
    const v = f[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    return null
  }
  const resolved = resolveRadarTop10({
    gmgnTop10: num('gmgn_top_10_holder_rate'),
    jupiterTop10Pct:
      params.jupiterTop10Pct ??
      num('jupiter_top_holders_pct') ??
      num('top_holders_pct'),
  })

  return {
    sm: params.sm,
    kol: params.kol,
    holders: num('gmgn_holder_count'),
    top10: resolved.top10,
    top10Source: resolved.top10Source,
    honeypot:
      f.gmgn_honeypot === true || f.is_honeypot === true
        ? true
        : f.gmgn_honeypot === false
          ? false
          : null,
    buySellReturnPct: num('buy_sell_return_pct') ?? num('gmgn_buy_sell_return'),
    activityScore:
      params.activityScore ??
      num('gmgn_activity_score') ??
      num('gmgn_activity_score_60m'),
    earlySignalsScore:
      params.earlySignalsScore ?? num('early_signals_score'),
    earlyGrowthPct: params.earlyGrowthPct ?? num('early_growth_pct'),
  }
}

function formatRadarPriceMcapLine(
  priceUsd?: number | null,
  mcapUsd?: number | null,
): string | null {
  const hasPrice =
    priceUsd != null && Number.isFinite(priceUsd) && priceUsd > 0
  const hasMcap = mcapUsd != null && Number.isFinite(mcapUsd) && mcapUsd > 0
  if (!hasPrice && !hasMcap) return null
  const pricePart = hasPrice
    ? `$${priceUsd!.toLocaleString('en-US', { maximumSignificantDigits: 4 })}`
    : '—'
  const mcapPart = hasMcap ? formatMcapCompact(mcapUsd!) : '—'
  return `💰 ${pricePart} · MC ${mcapPart}`
}

function formatMcapCompact(mcap: number): string {
  if (mcap >= 1_000_000) return `$${(mcap / 1_000_000).toFixed(2)}M`
  if (mcap >= 1_000) return `$${(mcap / 1_000).toFixed(1)}K`
  return `$${mcap.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

export function formatGmgnRadarTelegramHtml(params: {
  review: GmgnRadarReview
  symbol?: string | null
  tokenAddress: string
  category?: string | null
  eventLabel?: string | null
  priceUsd?: number | null
  mcapUsd?: number | null
}): string {
  const sym = params.symbol?.trim() || 'UNKNOWN'
  const cat = params.category?.trim() || 'GMGN'
  const event = params.eventLabel?.trim()
  const pxLine = formatRadarPriceMcapLine(params.priceUsd, params.mcapUsd)
  const lines = [
    `<b>NEW TOKEN</b> · ${cat} · <b>${escapeHtml(sym)}</b>`,
    event ? `<i>${escapeHtml(event)}</i>` : null,
    '',
    `🧠 <b>Radar:</b> ${params.review.emoji} <b>${params.review.action}</b> (${params.review.score}/100)`,
    `<i>${escapeHtml(params.review.summary)}</i>`,
    pxLine,
    '',
    `📊 <b>GMGN:</b> ${escapeHtml(params.review.gmgnLine)}`,
    '',
    `<code>${escapeHtml(params.tokenAddress)}</code>`,
  ]
  return lines.filter((l): l is string => l != null).join('\n')
}

function formatPct(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return '—'
  const sign = pct >= 0 ? '+' : ''
  return `${sign}${pct.toFixed(1)}%`
}

function formatPriceCompact(price: number | null | undefined): string {
  if (price == null || !Number.isFinite(price) || price <= 0) return '—'
  return `$${price.toLocaleString('en-US', { maximumSignificantDigits: 4 })}`
}

export type RadarThreadStage = 'fresh' | 'tracking' | 'surge' | 'fade'

const FRESH_AGE_MS = 20 * 60_000

export function deriveRadarThreadStage(params: {
  openedAt: string | null | undefined
  mcapPctVsInitial: number | null | undefined
  peakSm: number
  radarAction: GmgnRadarAction
  nowMs?: number
}): RadarThreadStage {
  const now = params.nowMs ?? Date.now()
  const openedMs = params.openedAt ? Date.parse(params.openedAt) : NaN
  const ageMs = Number.isFinite(openedMs) ? Math.max(0, now - openedMs) : 0
  const mcapPct = params.mcapPctVsInitial
  const surge =
    params.radarAction === 'ENTER' ||
    params.peakSm >= 5 ||
    (mcapPct != null && Number.isFinite(mcapPct) && mcapPct >= 50)
  if (surge) return 'surge'
  if (mcapPct != null && Number.isFinite(mcapPct) && mcapPct <= -40) return 'fade'
  if (ageMs >= FRESH_AGE_MS) return 'tracking'
  return 'fresh'
}

function formatAgeCompact(openedAt: string | null | undefined, nowMs = Date.now()): string {
  const openedMs = openedAt ? Date.parse(openedAt) : NaN
  if (!Number.isFinite(openedMs)) return '—'
  const mins = Math.max(0, Math.floor((nowMs - openedMs) / 60_000))
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function stageHeaderLabel(
  kind: 'new' | 'comeback' | 'dead',
  stage: RadarThreadStage,
): string {
  if (kind === 'dead') return '☠️ <b>RUG / DEAD</b>'
  if (kind === 'comeback') return '♻️ <b>COMEBACK</b>'
  if (stage === 'surge') return '🚀 <b>SURGE</b>'
  if (stage === 'fade') return '📉 <b>FADING</b>'
  if (stage === 'tracking') return '👀 <b>TRACKING</b>'
  return '<b>NEW TOKEN</b>'
}

/** Live Radar card: one message per lifecycle (edited until dead). */
export function formatGmgnRadarLiveThreadHtml(params: {
  kind: 'new' | 'comeback' | 'dead'
  review: GmgnRadarReview
  symbol?: string | null
  tokenAddress: string
  category?: string | null
  lifecycle: number
  peakSm: number
  peakKol: number
  initialPriceUsd: number | null
  initialMcapUsd: number | null
  priceUsd: number | null
  mcapUsd: number | null
  pricePctVsLast: number | null
  mcapPctVsLast: number | null
  pricePctVsInitial?: number | null
  mcapPctVsInitial?: number | null
  deathReason?: string | null
  openedAt?: string | null
  peakMcapUsd?: number | null
}): string {
  const sym = params.symbol?.trim() || 'UNKNOWN'
  const cat = params.category?.trim() || 'GMGN'
  const stage = deriveRadarThreadStage({
    openedAt: params.openedAt,
    mcapPctVsInitial: params.mcapPctVsInitial,
    peakSm: params.peakSm,
    radarAction: params.review.action,
  })
  const header = `${stageHeaderLabel(params.kind, stage)} · ${cat} · <b>${escapeHtml(sym)}</b>`

  const peakMcap = params.peakMcapUsd
  const peakLine =
    peakMcap != null && peakMcap > 0
      ? `📈 <b>Peak MC:</b> ${formatMcapCompact(peakMcap)}${
          params.mcapUsd != null && params.mcapUsd > 0
            ? ` (${formatPct(((params.mcapUsd - peakMcap) / peakMcap) * 100)} vs peak)`
            : ''
        }`
      : null
  const ageLine = params.openedAt
    ? `⏱ <b>Age:</b> ${formatAgeCompact(params.openedAt)}`
    : null

  const lines = [
    header,
    `Lifecycle #${params.lifecycle}`,
    '',
    `🧠 <b>Radar:</b> ${params.review.emoji} <b>${params.review.action}</b> (${params.review.score}/100)`,
    `<i>${escapeHtml(params.review.summary)}</i>`,
    '',
    `📌 <b>Initial:</b> ${formatPriceCompact(params.initialPriceUsd)} · MC ${params.initialMcapUsd != null && params.initialMcapUsd > 0 ? formatMcapCompact(params.initialMcapUsd) : '—'}`,
    `💰 <b>Now:</b> ${formatPriceCompact(params.priceUsd)} · MC ${params.mcapUsd != null && params.mcapUsd > 0 ? formatMcapCompact(params.mcapUsd) : '—'}`,
    ageLine,
    peakLine,
    `Δ vs last: price ${formatPct(params.pricePctVsLast)} · MC ${formatPct(params.mcapPctVsLast)}`,
    params.pricePctVsInitial != null || params.mcapPctVsInitial != null
      ? `Δ vs initial: price ${formatPct(params.pricePctVsInitial ?? null)} · MC ${formatPct(params.mcapPctVsInitial ?? null)}`
      : null,
    `👥 <b>SM</b> ${params.peakSm} · <b>KOL</b> ${params.peakKol}`,
    '',
    `📊 <b>GMGN:</b> ${escapeHtml(params.review.gmgnLine)}`,
    params.deathReason
      ? `<i>${escapeHtml(params.deathReason)}</i>`
      : null,
    '',
    `<code>${escapeHtml(params.tokenAddress)}</code>`,
  ]
  return lines.filter((l): l is string => l != null).join('\n')
}

/** Dedicated Rug alert (always shared even though SKIP is not). */
export function formatGmgnRadarRugTelegramHtml(params: {
  symbol?: string | null
  tokenAddress: string
  previousMcapUsd: number | null
  currentMcapUsd: number | null
  priceUsd?: number | null
  reason: string
}): string {
  const sym = params.symbol?.trim() || 'UNKNOWN'
  const prev =
    params.previousMcapUsd != null && params.previousMcapUsd > 0
      ? formatMcapCompact(params.previousMcapUsd)
      : '—'
  const cur =
    params.currentMcapUsd != null && params.currentMcapUsd > 0
      ? formatMcapCompact(params.currentMcapUsd)
      : '—'
  const pxLine = formatRadarPriceMcapLine(
    params.priceUsd,
    params.currentMcapUsd,
  )
  const lines = [
    `☠️ <b>RUG</b> · Radar · <b>${escapeHtml(sym)}</b>`,
    '',
    `MC ${prev} → ${cur}`,
    pxLine,
    `<i>${escapeHtml(params.reason)}</i>`,
    '',
    `<code>${escapeHtml(params.tokenAddress)}</code>`,
  ]
  return lines.filter((l): l is string => l != null).join('\n')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
