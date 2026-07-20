/** Compact OHLC strip for Telegram HTML (editMessageText-safe). */

import {
  fetchLastOhlcRugBars,
  getLatestDetectSnapshot,
} from '@/strategies/detect-snapshots'
import {
  OHLC_RUG_MAX_BARS,
  type OhlcRugBar,
} from '@/strategies/ohlc-rug-rules'

const BLOCKS = '▁▂▃▄▅▆▇█'

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

/**
 * Paint ≤10 bars as a `<pre>` sparkline + o→c / dump stats.
 * Returns empty string when no bars (caller omits section).
 */
export function formatOhlcTelegramPre(bars: OhlcRugBar[]): string {
  if (!Array.isArray(bars) || bars.length === 0) return ''

  const sliced = bars.slice(-OHLC_RUG_MAX_BARS)
  const lows = sliced.map((b) => b.l)
  const highs = sliced.map((b) => b.h)
  const minL = Math.min(...lows)
  const maxH = Math.max(...highs)
  const span = Math.max(maxH - minL, 1e-12)

  const spark = sliced
    .map((b) => BLOCKS[barCloseLevel(b, minL, span)]!)
    .join('')

  const first = sliced[0]!
  const last = sliced[sliced.length - 1]!
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
    `${sliced.length}b`,
  ]
    .filter((x): x is string => x != null)
    .join(' · ')

  const body = `${spark}\n${stats}`
  return `<pre>${escapeHtml(body)}</pre>`
}

/** Prefer saved Freeview detect snapshot; else live last-10×1m. */
export async function loadOhlcBarsForTelegram(
  tokenAddress: string,
): Promise<OhlcRugBar[]> {
  try {
    const snap = await getLatestDetectSnapshot(tokenAddress)
    if (snap?.bars?.length) {
      return snap.bars.slice(-OHLC_RUG_MAX_BARS)
    }
  } catch {
    /* fall through */
  }
  try {
    const { bars } = await fetchLastOhlcRugBars(tokenAddress)
    return bars
  } catch {
    return []
  }
}
