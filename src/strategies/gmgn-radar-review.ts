/** GMGN metrics → Radar review (WATCH / SKIP / ENTER) like Telegram alpha feeds. */

export type GmgnRadarAction = 'ENTER' | 'WATCH' | 'SKIP'

export type GmgnRadarInput = {
  sm: number
  kol: number
  holders?: number | null
  /** Top-10 share as percent (14) or fraction (0.14). */
  top10?: number | null
  taxPct?: number | null
  honeypot?: boolean | null
  liquidityUsd?: number | null
  buySellReturnPct?: number | null
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
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function normalizeTop10Pct(top10: number | null | undefined): number | null {
  if (top10 == null || !Number.isFinite(top10)) return null
  // fraction 0–1 → percent
  if (top10 > 0 && top10 <= 1) return top10 * 100
  return top10
}

export function scoreGmgnRadar(input: GmgnRadarInput): number {
  if (input.honeypot) return 10

  let score = 12
  score += Math.min(Math.max(0, input.sm), 40) * 0.55
  score += Math.min(Math.max(0, input.kol), 40) * 0.35

  const holders = input.holders
  if (holders != null && holders > 0) {
    score += Math.min(Math.log10(holders + 1) * 5, 10)
  }

  const top10 = normalizeTop10Pct(input.top10)
  if (top10 != null) {
    if (top10 <= 12) score += 6
    else if (top10 <= 20) score += 2
    else if (top10 <= 35) score -= 12
    else score -= 25
  }

  const tax = input.taxPct
  if (tax != null) {
    if (tax <= 0) score += 6
    else if (tax <= 2) score -= 5
    else score -= 25
  }

  const liq = input.liquidityUsd
  if (liq != null) {
    if (liq >= 50_000) score += 4
    else if (liq >= 10_000) score += 2
    else if (liq < 3_000) score -= 15
  }

  const ret = input.buySellReturnPct
  if (ret != null) {
    if (ret >= 95) score += 4
    else if (ret < 80) score -= 20
  }

  if (input.sm <= 0 && input.kol <= 0) {
    score = Math.min(score, 28)
  }

  return Math.round(clamp(score, 0, 100))
}

export function actionFromRadarScore(score: number): GmgnRadarAction {
  if (score >= 78) return 'ENTER'
  if (score >= 45) return 'WATCH'
  return 'SKIP'
}

function actionEmoji(action: GmgnRadarAction): string {
  if (action === 'ENTER') return '🟢'
  if (action === 'WATCH') return '🟡'
  return '🔴'
}

function buildReasons(input: GmgnRadarInput): string[] {
  const reasons: string[] = []
  if (input.honeypot) {
    reasons.push('honeypot risk')
    return reasons
  }
  if (input.honeypot === false) reasons.push('no honeypot')

  const tax = input.taxPct
  if (tax != null && tax <= 0) reasons.push('zero tax')
  else if (tax != null && tax > 2) reasons.push(`high tax ${tax}%`)

  const top10 = normalizeTop10Pct(input.top10)
  if (top10 != null) {
    if (top10 <= 15) reasons.push('moderate holder spread')
    else if (top10 <= 25) reasons.push('moderate holder concentration')
    else reasons.push('high holder concentration')
  }

  if (input.sm <= 0 && input.kol <= 0) reasons.push('no smart money')
  else if (input.sm > 0 && input.kol > 0) reasons.push('SM+KOL overlap')
  else if (input.sm > 0) reasons.push('smart money present')
  else reasons.push('KOL interest only')

  const liq = input.liquidityUsd
  if (liq != null) {
    if (liq >= 50_000) reasons.push('high liquidity depth')
    else if (liq < 5_000) reasons.push('low liquidity')
  }

  const ret = input.buySellReturnPct
  if (ret != null && ret < 90) reasons.push('high slippage')

  if (input.holders != null && input.holders < 1500 && input.sm <= 0) {
    reasons.push('thin holder base')
  }

  return reasons
}

function summarize(action: GmgnRadarAction, reasons: string[]): string {
  if (reasons.length === 0) {
    return action === 'SKIP'
      ? 'Insufficient GMGN signal — too risky.'
      : 'Limited GMGN signal — monitor before sizing up.'
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
  const top10Str = top10 != null ? `${top10.toFixed(0)}%` : '—'
  const taxStr = input.taxPct != null ? `${input.taxPct}%` : '—'

  return {
    action,
    score,
    emoji: actionEmoji(action),
    summary: summarize(action, reasons),
    gmgnLine: `SM ${input.sm} · KOL ${input.kol} · hold ${hold} · top10 ${top10Str} · tax ${taxStr}`,
    reasons,
  }
}

/** Map security-gate feature bag + activity counts into radar input. */
export function gmgnRadarInputFromFeatures(params: {
  sm: number
  kol: number
  features?: Record<string, unknown>
}): GmgnRadarInput {
  const f = params.features ?? {}
  const num = (k: string): number | null => {
    const v = f[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    return null
  }
  const top10Raw = num('gmgn_top_10_holder_rate')
  return {
    sm: params.sm,
    kol: params.kol,
    holders: num('gmgn_holder_count'),
    top10: top10Raw,
    taxPct: num('buy_tax') ?? num('sell_tax') ?? num('gmgn_tax_pct'),
    honeypot:
      f.gmgn_honeypot === true || f.is_honeypot === true
        ? true
        : f.gmgn_honeypot === false
          ? false
          : null,
    liquidityUsd: num('gmgn_liquidity_usd'),
  }
}

export function formatGmgnRadarTelegramHtml(params: {
  review: GmgnRadarReview
  symbol?: string | null
  tokenAddress: string
  category?: string | null
  eventLabel?: string | null
}): string {
  const sym = params.symbol?.trim() || 'UNKNOWN'
  const cat = params.category?.trim() || 'GMGN'
  const event = params.eventLabel?.trim()
  const lines = [
    `<b>NEW TOKEN</b> · ${cat} · <b>${escapeHtml(sym)}</b>`,
    event ? `<i>${escapeHtml(event)}</i>` : null,
    '',
    `🧠 <b>Radar:</b> ${params.review.emoji} <b>${params.review.action}</b> (${params.review.score}/100)`,
    `<i>${escapeHtml(params.review.summary)}</i>`,
    '',
    `📊 <b>GMGN:</b> ${escapeHtml(params.review.gmgnLine)}`,
    '',
    `<code>${escapeHtml(params.tokenAddress)}</code>`,
  ]
  return lines.filter((l): l is string => l != null).join('\n')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
