/** Compact OHLC strip + shared Telegram photo/text send. */

import {
  getCachedTokenOhlc24h1m,
  tokenOhlcToRugBars,
} from '@/strategies/token-map-chart'
import { renderOhlcCandlesPng } from '@/strategies/ohlc-telegram-svg'
import type { OhlcRugBar } from '@/strategies/ohlc-rug-rules'
import {
  sendTelegramMessage,
  sendTelegramPhoto,
  type TelegramInlineButton,
  type TelegramSendResult,
} from '@/utils/telegram'

const BLOCKS = '▁▂▃▄▅▆▇█'
/** Sparkline max width in text fallback */
const SPARK_MAX = 24

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function barCloseLevel(bar: OhlcRugBar, minL: number, span: number): number {
  if (span <= 0) return 4
  const n = Math.round(((bar.c - minL) / span) * (BLOCKS.length - 1))
  return Math.max(0, Math.min(BLOCKS.length - 1, n))
}

function fmtPx(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1) return n.toFixed(4)
  if (n >= 0.0001) return n.toPrecision(4)
  return n.toExponential(2)
}

function downsampleBars(bars: OhlcRugBar[], maxN: number): OhlcRugBar[] {
  if (bars.length <= maxN) return bars
  const out: OhlcRugBar[] = []
  const step = bars.length / maxN
  for (let i = 0; i < maxN; i++) {
    out.push(bars[Math.min(bars.length - 1, Math.floor(i * step))]!)
  }
  return out
}

/**
 * Paint series as a `<pre>` sparkline + o→c / dump stats (downsampled).
 * Returns empty string when no bars (caller omits section).
 */
export function formatOhlcTelegramPre(bars: OhlcRugBar[]): string {
  if (!Array.isArray(bars) || bars.length === 0) return ''

  const first = bars[0]!
  const last = bars[bars.length - 1]!
  const sparkBars = downsampleBars(bars, SPARK_MAX)
  const lows = sparkBars.map((b) => b.l)
  const highs = sparkBars.map((b) => b.h)
  const minL = Math.min(...lows)
  const maxH = Math.max(...highs)
  const span = Math.max(maxH - minL, 1e-12)

  const spark = sparkBars
    .map((b) => BLOCKS[barCloseLevel(b, minL, span)]!)
    .join('')

  const dumpPct =
    first.h > 0 ? ((first.h - last.l) / first.h) * 100 : null
  const chgPct =
    first.o > 0 ? ((last.c - first.o) / first.o) * 100 : null

  const stats = [
    `${fmtPx(first.o)}→${fmtPx(last.c)}`,
    chgPct != null && Number.isFinite(chgPct)
      ? `${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(1)}%`
      : null,
    dumpPct != null && Number.isFinite(dumpPct)
      ? `dump ${dumpPct.toFixed(0)}%`
      : null,
    `${bars.length}b · 24h`,
  ]
    .filter((x): x is string => x != null)
    .join(' · ')

  const body = `${spark}\n${stats}`
  return `<pre>${escapeHtml(body)}</pre>`
}

/** Full cached 24h×1m series for Telegram charts. */
export async function loadOhlcBarsForTelegram(
  tokenAddress: string,
): Promise<OhlcRugBar[]> {
  try {
    const { candles } = await getCachedTokenOhlc24h1m(tokenAddress)
    return tokenOhlcToRugBars(candles)
  } catch {
    return []
  }
}

export async function loadAndRenderOhlcPng(
  tokenAddress: string,
  symbol?: string | null,
): Promise<{ bars: OhlcRugBar[]; png: Buffer | null }> {
  const bars = await loadOhlcBarsForTelegram(tokenAddress)
  const png = await renderOhlcCandlesPng(bars, { symbol })
  return { bars, png }
}

export type SendTelegramOhlcResult = TelegramSendResult & {
  usedPhoto: boolean
}

/**
 * Prefer PNG candlestick photo; fall back to HTML text + OHLC sparkline.
 */
export async function sendTelegramOhlcPhotoOrText(params: {
  tokenAddress: string
  symbol?: string | null
  caption: string
  textBody: string
  chatId?: string
  inlineKeyboard?: Array<Array<TelegramInlineButton>>
}): Promise<SendTelegramOhlcResult> {
  const { bars, png } = await loadAndRenderOhlcPng(
    params.tokenAddress,
    params.symbol,
  )

  if (png) {
    const sent = await sendTelegramPhoto({
      png,
      caption: params.caption,
      chatId: params.chatId,
      parseMode: 'HTML',
      inlineKeyboard: params.inlineKeyboard,
    })
    if (sent.ok) {
      return { ...sent, usedPhoto: true }
    }
  }

  const ohlcPre = formatOhlcTelegramPre(bars)
  let text = params.textBody
  if (ohlcPre && !text.includes(ohlcPre) && !text.includes('OHLC 24h')) {
    text = `${text}\n\n📈 <b>OHLC 24h</b>\n${ohlcPre}`
  }

  const sent = await sendTelegramMessage(text, {
    chatId: params.chatId,
    parseMode: 'HTML',
    inlineKeyboard: params.inlineKeyboard,
  })
  return { ...sent, usedPhoto: false }
}
