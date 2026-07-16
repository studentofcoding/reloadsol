/** Pinned daily strategy PnL leaderboard (cron id gmgn_radar_digest — name is historical). */

import {
  listTopPnlByActiveStrategy,
  type StrategyPnlLeaderboardSection,
} from './db'
import { readTokenSymbol } from './outcome-features'
import type { StrategyOutcomeRow } from './types'
import {
  ensureRadarDigestPinsTable,
  getRadarDigestPin,
  upsertRadarDigestPin,
} from './gmgn-radar-digest-db'
import {
  editTelegramMessage,
  getTelegramAlertChatId,
  isStrategyTrackTelegramEnabled,
  pinTelegramMessage,
  sendTelegramMessage,
  unpinTelegramMessage,
} from '@/utils/telegram'

const TOP_N = 8
const TELEGRAM_MAX_CHARS = 4000
const PNL_WINDOW_MS = 24 * 60 * 60 * 1000
/** Rolling window label (Asia/Bangkok wall clock context for operators). */
export const PNL_DIGEST_WINDOW_LABEL = '24h (Bangkok)'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function formatPct(pct: number): string {
  const sign = pct >= 0 ? '+' : ''
  return `${sign}${pct.toFixed(0)}%`
}

function tradeSymbol(row: StrategyOutcomeRow): string {
  return readTokenSymbol(row.features) || 'UNKNOWN'
}

function formatExitDate(row: StrategyOutcomeRow): string {
  const raw = row.exit_at || row.created_at
  if (!raw) return '—'
  const d = new Date(raw)
  if (!Number.isFinite(d.getTime())) return '—'
  return d.toISOString().slice(0, 10)
}

export function formatStrategyPnlLeaderboardHtml(params: {
  sections: StrategyPnlLeaderboardSection[]
  updatedAt: Date
  topN?: number
  windowLabel?: string
}): string {
  const topN = params.topN ?? TOP_N
  const windowLabel = params.windowLabel ?? PNL_DIGEST_WINDOW_LABEL
  const when = params.updatedAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  const lines: string[] = [
    `📌 <b>Strategy PnL</b> · top ${topN} · active · ${escapeHtml(windowLabel)}`,
    `<i>Updated ${escapeHtml(when)}</i>`,
    '',
  ]

  if (params.sections.length === 0) {
    lines.push('<i>No closed PnL for active strategies in the last 24h.</i>')
    return lines.join('\n')
  }

  for (const section of params.sections) {
    lines.push(
      `— <b>${escapeHtml(section.strategy_id)}</b> (${escapeHtml(section.domain)}) —`,
    )
    section.trades.forEach((trade, i) => {
      const mode = trade.is_simulated ? 'SIM' : 'LIVE'
      const pct = formatPct(Number(trade.pnl_pct))
      const sym = escapeHtml(tradeSymbol(trade))
      lines.push(
        `${i + 1}. <b>${pct}</b> [${mode}] ${sym} · exit ${escapeHtml(formatExitDate(trade))}`,
      )
      if (trade.token_address) {
        lines.push(`<code>${escapeHtml(trade.token_address)}</code>`)
      }
    })
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

/** Drop sparse sections, then trailing trades, until HTML fits Telegram. */
export function fitPnlLeaderboardSections(
  sections: StrategyPnlLeaderboardSection[],
  updatedAt: Date,
  maxChars = TELEGRAM_MAX_CHARS,
  windowLabel = PNL_DIGEST_WINDOW_LABEL,
): { sections: StrategyPnlLeaderboardSection[]; html: string } {
  let current = sections.map((s) => ({ ...s, trades: [...s.trades] }))
  for (;;) {
    const html = formatStrategyPnlLeaderboardHtml({
      sections: current,
      updatedAt,
      windowLabel,
    })
    if (html.length <= maxChars) {
      return { sections: current, html }
    }
    if (current.length > 1) {
      let dropIdx = 0
      for (let i = 1; i < current.length; i++) {
        const a = current[i]!
        const b = current[dropIdx]!
        if (
          a.trades.length < b.trades.length ||
          (a.trades.length === b.trades.length && a.name > b.name)
        ) {
          dropIdx = i
        }
      }
      current = current.filter((_, i) => i !== dropIdx)
      continue
    }
    const only = current[0]
    if (!only || only.trades.length <= 1) {
      return { sections: current, html }
    }
    only.trades = only.trades.slice(0, -1)
  }
}

export async function publishRadarDigest(): Promise<{
  ok: boolean
  chatId: string | null
  messageId: number | null
  sectionCount: number
  tradeCount: number
  edited: boolean
  reason?: string
}> {
  if (!isStrategyTrackTelegramEnabled()) {
    return {
      ok: false,
      chatId: null,
      messageId: null,
      sectionCount: 0,
      tradeCount: 0,
      edited: false,
      reason: 'telegram disabled',
    }
  }

  const chatId =
    process.env.GMGN_RADAR_DIGEST_CHAT_ID?.trim() || getTelegramAlertChatId()
  if (!chatId) {
    return {
      ok: false,
      chatId: null,
      messageId: null,
      sectionCount: 0,
      tradeCount: 0,
      edited: false,
      reason: 'no chat id',
    }
  }

  await ensureRadarDigestPinsTable()
  const updatedAt = new Date()
  const sinceIso = new Date(updatedAt.getTime() - PNL_WINDOW_MS).toISOString()
  const rawSections = await listTopPnlByActiveStrategy(TOP_N, { sinceIso })
  const { sections, html: text } = fitPnlLeaderboardSections(rawSections, updatedAt)
  const tradeCount = sections.reduce((n, s) => n + s.trades.length, 0)

  const existing = await getRadarDigestPin(chatId)
  if (existing) {
    const edited = await editTelegramMessage({
      chatId,
      messageId: existing.message_id,
      text,
      parseMode: 'HTML',
    })
    if (edited) {
      await upsertRadarDigestPin({
        chat_id: chatId,
        message_id: existing.message_id,
      })
      await pinTelegramMessage({
        chatId,
        messageId: existing.message_id,
      })
      return {
        ok: true,
        chatId,
        messageId: existing.message_id,
        sectionCount: sections.length,
        tradeCount,
        edited: true,
      }
    }
    await unpinTelegramMessage({
      chatId,
      messageId: existing.message_id,
    })
  }

  const sent = await sendTelegramMessage(text, {
    chatId,
    parseMode: 'HTML',
  })
  if (!sent.ok || sent.messageId == null) {
    return {
      ok: false,
      chatId,
      messageId: null,
      sectionCount: sections.length,
      tradeCount,
      edited: false,
      reason: 'send failed',
    }
  }

  await upsertRadarDigestPin({
    chat_id: chatId,
    message_id: sent.messageId,
  })
  await pinTelegramMessage({ chatId, messageId: sent.messageId })

  return {
    ok: true,
    chatId,
    messageId: sent.messageId,
    sectionCount: sections.length,
    tradeCount,
    edited: false,
  }
}
