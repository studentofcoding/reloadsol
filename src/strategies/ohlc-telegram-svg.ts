/** SVG / PNG candlestick render for Telegram sendPhoto. */

import sharp from 'sharp'
import type { OhlcRugBar } from '@/strategies/ohlc-rug-rules'

export type OhlcSvgOpts = {
  width?: number
  height?: number
  symbol?: string | null
  /** Chart title suffix; default "24h OHLC". */
  titleSuffix?: string
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Pure SVG candlesticks for full series. Empty → null. */
export function renderOhlcCandlesSvg(
  bars: OhlcRugBar[],
  opts: OhlcSvgOpts = {},
): string | null {
  if (!Array.isArray(bars) || bars.length === 0) return null

  const width = opts.width ?? 640
  const height = opts.height ?? 320
  const padTop = opts.symbol ? 28 : 12
  const pad = 12
  const padBot = 12
  const chartTop = padTop
  const chartH = height - chartTop - padBot
  const chartW = width - pad * 2
  const titleSuffix = opts.titleSuffix ?? '24h OHLC'

  const highs = bars.map((b) => b.h)
  const lows = bars.map((b) => b.l)
  const maxH = Math.max(...highs)
  const minL = Math.min(...lows)
  const span = Math.max(maxH - minL, 1e-12)

  const y = (price: number) =>
    chartTop + ((maxH - price) / span) * chartH

  const slot = chartW / bars.length
  const parts: string[] = []

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  )
  parts.push(`<rect width="${width}" height="${height}" fill="#111827"/>`)

  if (opts.symbol?.trim()) {
    parts.push(
      `<text x="${pad}" y="20" fill="#9ca3af" font-family="ui-sans-serif,system-ui,sans-serif" font-size="14">${esc(opts.symbol.trim())} · ${esc(titleSuffix)}</text>`,
    )
  }

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!
    const x = pad + i * slot + slot / 2
    const up = b.c >= b.o
    const color = up ? '#34d399' : '#f87171'
    const yH = y(b.h)
    const yL = y(b.l)
    const yO = y(b.o)
    const yC = y(b.c)
    const bodyTop = Math.min(yO, yC)
    const bodyH = Math.max(Math.abs(yC - yO), 1.5)
    const bodyW = Math.max(Math.min(slot * 0.55, 8), 1)

    parts.push(
      `<line x1="${x}" x2="${x}" y1="${yH}" y2="${yL}" stroke="${color}" stroke-width="1"/>`,
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
