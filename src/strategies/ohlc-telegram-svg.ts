/** SVG / PNG candlestick render for Telegram sendPhoto. */

import sharp from 'sharp'
import {
  OHLC_RUG_MAX_BARS,
  type OhlcRugBar,
} from '@/strategies/ohlc-rug-rules'

export type OhlcSvgOpts = {
  width?: number
  height?: number
  symbol?: string | null
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Pure SVG candlesticks (≤10 bars). Empty → null. */
export function renderOhlcCandlesSvg(
  bars: OhlcRugBar[],
  opts: OhlcSvgOpts = {},
): string | null {
  if (!Array.isArray(bars) || bars.length === 0) return null

  const sliced = bars.slice(-OHLC_RUG_MAX_BARS)
  const width = opts.width ?? 640
  const height = opts.height ?? 320
  const padTop = opts.symbol ? 28 : 12
  const pad = 12
  const padBot = 12
  const chartTop = padTop
  const chartH = height - chartTop - padBot
  const chartW = width - pad * 2

  const highs = sliced.map((b) => b.h)
  const lows = sliced.map((b) => b.l)
  const maxH = Math.max(...highs)
  const minL = Math.min(...lows)
  const span = Math.max(maxH - minL, 1e-12)

  const y = (price: number) =>
    chartTop + ((maxH - price) / span) * chartH

  const slot = chartW / sliced.length
  const parts: string[] = []

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  )
  parts.push(`<rect width="${width}" height="${height}" fill="#111827"/>`)

  if (opts.symbol?.trim()) {
    parts.push(
      `<text x="${pad}" y="20" fill="#9ca3af" font-family="ui-sans-serif,system-ui,sans-serif" font-size="14">${esc(opts.symbol.trim())} · 10m OHLC</text>`,
    )
  }

  for (let i = 0; i < sliced.length; i++) {
    const b = sliced[i]!
    const x = pad + i * slot + slot / 2
    const up = b.c >= b.o
    const color = up ? '#34d399' : '#f87171'
    const yH = y(b.h)
    const yL = y(b.l)
    const yO = y(b.o)
    const yC = y(b.c)
    const bodyTop = Math.min(yO, yC)
    const bodyH = Math.max(Math.abs(yC - yO), 1.5)
    const bodyW = Math.max(slot * 0.55, 4)

    parts.push(
      `<line x1="${x}" x2="${x}" y1="${yH}" y2="${yL}" stroke="${color}" stroke-width="1.5"/>`,
    )
    parts.push(
      `<rect x="${x - bodyW / 2}" y="${bodyTop}" width="${bodyW}" height="${bodyH}" fill="${color}"/>`,
    )
  }

  parts.push('</svg>')
  return parts.join('')
}

/** Rasterize SVG candles to PNG. Empty / sharp fail → null. */
export async function renderOhlcCandlesPng(
  bars: OhlcRugBar[],
  opts: OhlcSvgOpts = {},
): Promise<Buffer | null> {
  const svg = renderOhlcCandlesSvg(bars, opts)
  if (!svg) return null
  try {
    return await sharp(Buffer.from(svg)).png().toBuffer()
  } catch (err) {
    console.warn(
      '[ohlc-telegram-svg] sharp PNG failed',
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}
