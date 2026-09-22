/**
 * Best-strategy FOLLOW alert (Telegram) — not entry / soft-gate / Noul / paper.
 * Room hygiene: label as follow only; mint+arm cooldown. No OHLC bars → GMGN
 * URL text. Any bars → the same sharp OHLC PNG as strategy close charts.
 * Blast names arm(s) + avg×n rank context + chart link.
 */

import {
  loadOhlcBarsForTelegram,
  sendTelegramOhlcPhotoOrText,
} from '@/strategies/ohlc-telegram-paint'
import type { BestStrategyRankRow } from '@/strategies/best-strategies-rank'
import { getQualifiedBestStrategyRank } from '@/strategies/best-strategies-qualify'
import {
  formatMcapUsd,
  formatReloadsolChartLink,
  formatTelegramBuyLink,
  isStrategyTrackTelegramEnabled,
  sendTelegramMessage,
} from '@/utils/telegram'
import { getGmgnKlineUrl, getGmgnTokenUrl, inferGmgnChain } from '@/utils/gmgn'
import { scheduleOffRequestPath } from '@/strategies/schedule-off-request'
import { isMcapFollowAlertStrategy } from '@/strategies/mcap-sim-open-alerts'

/** PNG when at least one OHLC bar exists (same encode as close charts). */
export const FOLLOW_ALERT_MIN_OHLC_BARS = 1

const FOLLOW_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000
const followRecentKeys = new Map<string, number>()

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function pruneFollowKeys(now: number): void {
  const drop: string[] = []
  followRecentKeys.forEach((ts, key) => {
    if (now - ts > FOLLOW_DEDUP_WINDOW_MS) drop.push(key)
  })
  drop.forEach((k) => followRecentKeys.delete(k))
}

export function followAlertDedupKey(
  strategyId: string,
  tokenAddress: string,
): string {
  return `follow_alert:${strategyId}:${tokenAddress}`
}

/** Claim mint+arm cooldown slot. False if already blasted within window. */
export function claimFollowAlertCooldown(
  strategyId: string,
  tokenAddress: string,
): boolean {
  const now = Date.now()
  pruneFollowKeys(now)
  const key = followAlertDedupKey(strategyId, tokenAddress)
  const last = followRecentKeys.get(key)
  if (last && now - last <= FOLLOW_DEDUP_WINDOW_MS) return false
  followRecentKeys.set(key, now)
  return true
}

export function resetFollowAlertCooldownForTests(): void {
  followRecentKeys.clear()
}

/** Short arm name for blast: first_seen / 80% (RH twins included). */
export function followAlertArmLabel(strategyId: string): string {
  if (strategyId.includes('at_80')) {
    return strategyId.endsWith('_rh') ? '80% (RH)' : '80%'
  }
  if (strategyId.includes('first_seen')) {
    return strategyId.endsWith('_rh') ? 'first_seen (RH)' : 'first_seen'
  }
  return strategyId
}

export function isOhlcTooThinForFollowAlert(barCount: number): boolean {
  return !Number.isFinite(barCount) || barCount < FOLLOW_ALERT_MIN_OHLC_BARS
}

export function formatAvgXnRankContext(rank: {
  place: number
  avg_pnl_pct: number
  n: number
  win_pct: number
  score: number
}): string {
  const avg =
    `${rank.avg_pnl_pct >= 0 ? '+' : ''}${rank.avg_pnl_pct.toFixed(1)}%`
  return (
    `#${rank.place} · avg ${avg} × n=${rank.n} + win ${rank.win_pct.toFixed(0)}%` +
    ` → score ${rank.score.toFixed(0)}`
  )
}

export function buildBestStrategyFollowAlertHtml(params: {
  strategyId: string
  tokenSymbol: string
  tokenAddress: string
  mcap?: number | null
  rank: {
    place: number
    avg_pnl_pct: number
    n: number
    win_pct: number
    score: number
  } | null
  chartUrl: string
  chartKind: 'ohlc' | 'gmgn'
}): string {
  const arm = followAlertArmLabel(params.strategyId)
  const symbol = escapeHtml(params.tokenSymbol || 'UNKNOWN')
  const chartLabel =
    params.chartKind === 'gmgn' ? 'GMGN chart' : 'OHLC chart'
  const lines = [
    `👁 <b>Follow alert</b> · <i>not auto-enter</i>`,
    ``,
    `Arm: <b>${escapeHtml(arm)}</b> <code>${escapeHtml(params.strategyId)}</code>`,
    `Token: <b>${symbol}</b>`,
  ]
  if (params.mcap != null && Number.isFinite(params.mcap) && params.mcap > 0) {
    lines.push(`Mcap: ${formatMcapUsd(params.mcap)}`)
  }
  if (params.rank) {
    lines.push(`Rank (avg×n+win%): ${escapeHtml(formatAvgXnRankContext(params.rank))}`)
  } else {
    lines.push(`Rank (avg×n+win%): best-qualified arm`)
  }
  lines.push(
    ``,
    `<a href="${params.chartUrl}">${chartLabel}</a>` +
      ` · <a href="${formatTelegramBuyLink(params.tokenAddress)}">Buy</a>`,
    `<code>${escapeHtml(params.tokenAddress)}</code>`,
  )
  return lines.join('\n')
}

function rankFromRow(
  row: BestStrategyRankRow,
  place: number,
): {
  place: number
  avg_pnl_pct: number
  n: number
  win_pct: number
  score: number
} {
  return {
    place,
    avg_pnl_pct: row.avg_pnl_pct,
    n: row.n,
    win_pct: row.win_pct,
    score: row.score,
  }
}

export type BestStrategyFollowAlertParams = {
  strategyId: string
  tokenAddress: string
  tokenSymbol: string
  mcap?: number | null
  /** Skip cooldown (tests / admin). */
  force?: boolean
}

/**
 * Send a follow alert for a best arm hitting a mint.
 * Does not open positions, mention paper/Noul/soft-gate, or auto-enter.
 */
export async function sendBestStrategyFollowAlert(
  params: BestStrategyFollowAlertParams,
): Promise<{ sent: boolean; reason?: string; usedPhoto?: boolean }> {
  if (!isMcapFollowAlertStrategy(params.strategyId)) {
    return { sent: false, reason: 'arm_not_allowlisted' }
  }
  if (!isStrategyTrackTelegramEnabled()) {
    return { sent: false, reason: 'telegram_disabled' }
  }

  if (!params.force && !claimFollowAlertCooldown(params.strategyId, params.tokenAddress)) {
    return { sent: false, reason: 'cooldown' }
  }

  const ranked = await getQualifiedBestStrategyRank(params.strategyId)
  const rank = ranked
    ? rankFromRow(ranked.row, ranked.place)
    : null

  const chain = inferGmgnChain(params.tokenAddress)
  const gmgnKline = getGmgnKlineUrl(params.tokenAddress, { chain })
  const gmgnToken = getGmgnTokenUrl(params.tokenAddress, chain)
  const reloadChart = formatReloadsolChartLink(params.tokenAddress)

  const bars = await loadOhlcBarsForTelegram(params.tokenAddress)

  if (isOhlcTooThinForFollowAlert(bars.length)) {
    const text = buildBestStrategyFollowAlertHtml({
      strategyId: params.strategyId,
      tokenSymbol: params.tokenSymbol,
      tokenAddress: params.tokenAddress,
      mcap: params.mcap,
      rank,
      chartUrl: gmgnKline,
      chartKind: 'gmgn',
    })
    const sent = await sendTelegramMessage(text, {
      parseMode: 'HTML',
      inlineKeyboard: [
        [
          { text: 'GMGN chart', url: gmgnKline },
          { text: 'GMGN', url: gmgnToken },
        ],
        [{ text: 'Buy', url: formatTelegramBuyLink(params.tokenAddress) }],
      ],
    })
    return {
      sent: sent.ok,
      reason: sent.ok ? undefined : 'send_failed',
      usedPhoto: false,
    }
  }

  const text = buildBestStrategyFollowAlertHtml({
    strategyId: params.strategyId,
    tokenSymbol: params.tokenSymbol,
    tokenAddress: params.tokenAddress,
    mcap: params.mcap,
    rank,
    chartUrl: reloadChart,
    chartKind: 'ohlc',
  })

  const sent = await sendTelegramOhlcPhotoOrText({
    tokenAddress: params.tokenAddress,
    symbol: params.tokenSymbol,
    caption: text,
    textBody: text,
    bars,
    inlineKeyboard: [
      [
        { text: 'Chart', url: reloadChart },
        { text: 'GMGN', url: gmgnToken },
        { text: 'Buy', url: formatTelegramBuyLink(params.tokenAddress) },
      ],
    ],
  })

  return {
    sent: sent.ok,
    reason: sent.ok ? undefined : 'send_failed',
    usedPhoto: sent.usedPhoto,
  }
}

/**
 * Schedule a follow alert after the HTTP response. Sharp PNG encode must not
 * run on the request turn. Load failures reject inside the task and are logged;
 * encode errors after sharp loads fall back to text inside the photo helper.
 */
export function notifyBestStrategyFollowAlert(
  params: BestStrategyFollowAlertParams,
): void {
  scheduleOffRequestPath('[mcap-sim-open] follow alert failed', () =>
    sendBestStrategyFollowAlert(params).then(() => undefined),
  )
}

/** @deprecated use sendBestStrategyFollowAlert */
export async function sendBestStrategyShareTelegram(params: {
  strategyId: string
  tokenAddress: string
  tokenSymbol: string
  entryMcap?: number | null
  force?: boolean
}): Promise<boolean> {
  const result = await sendBestStrategyFollowAlert({
    strategyId: params.strategyId,
    tokenAddress: params.tokenAddress,
    tokenSymbol: params.tokenSymbol,
    mcap: params.entryMcap,
    force: params.force,
  })
  return result.sent
}
