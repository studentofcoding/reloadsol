/**
 * SVG / PNG candlestick render for Telegram sendPhoto — lightweight-charts
 * style: dark panel, green/red candles + volume histogram, gridlines, right
 * price axis, bottom time axis. Pixel-buckets long 1m series (up to 1440 bars)
 * so the SVG stays small and the candles are crisp at 1px-per-column.
 */

import { createRequire } from 'node:module'
import { closeSync, openSync, readdirSync, readSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { dirname, join } from 'node:path'
import type { OhlcRugBar } from '@/strategies/ohlc-rug-rules'

const require = createRequire(import.meta.url)

export type OhlcSvgOpts = {
  width?: number
  height?: number
  symbol?: string | null
  /** Chart title suffix; default "24h OHLC". */
  titleSuffix?: string
}

const UP = '#26a69a'
const DOWN = '#ef5350'
const BG = '#131722'
const GRID = '#1e222d'
const TEXT = '#d1d4dc'
const TEXT_DIM = '#787b86'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Compact price label like TradingView (auto k/m/B, else 4 sig figs). */
function fmtPrice(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  const abs = n
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}K`
  if (abs >= 1) return n.toPrecision(4)
  if (abs >= 1e-4) return n.toPrecision(3)
  return n.toExponential(1)
}

const BANGKOK_TZ = 'Asia/Bangkok'

function fmtTime(unixSec: number): string {
  try {
    return new Date(unixSec * 1000).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: BANGKOK_TZ,
    })
  } catch {
    return ''
  }
}

type Bucket = {
  open: number
  close: number
  high: number
  low: number
  volume: number
  timeSec: number
  count: number
}

/** Aggregate bars into ~1px-wide OHLC columns (last bucket keeps tail). */
function bucketBars(bars: OhlcRugBar[], columns: number): Bucket[] {
  if (bars.length <= columns) {
    return bars.map((b) => ({
      open: b.o,
      close: b.c,
      high: b.h,
      low: b.l,
      volume: b.v ?? 0,
      timeSec: b.t,
      count: 1,
    }))
  }
  const per = bars.length / columns
  const out: Bucket[] = []
  for (let col = 0; col < columns; col++) {
    const start = Math.floor(col * per)
    const end = Math.min(bars.length, Math.floor((col + 1) * per))
    if (start >= end) continue
    const slice = bars.slice(start, end)
    let high = -Infinity
    let low = Infinity
    let volume = 0
    for (const b of slice) {
      if (b.h > high) high = b.h
      if (b.l < low) low = b.l
      volume += b.v ?? 0
    }
    out.push({
      open: slice[0]!.o,
      close: slice[slice.length - 1]!.c,
      high,
      low,
      volume,
      timeSec: slice[0]!.t,
      count: slice.length,
    })
  }
  return out
}

/** Pure SVG lightweight-charts-style candles. Empty → null. */
export function renderOhlcCandlesSvg(
  bars: OhlcRugBar[],
  opts: OhlcSvgOpts = {},
): string | null {
  if (!Array.isArray(bars) || bars.length === 0) return null

  const width = opts.width ?? 640
  const height = opts.height ?? 340
  const titleSuffix = opts.titleSuffix ?? '24h OHLC'

  const padL = 10
  const padR = 62 // right price axis
  const titleH = opts.symbol?.trim() ? 30 : 12
  const timeH = 20
  const plotW = width - padL - padR
  const plotTotalH = height - titleH - timeH
  const priceH = Math.floor(plotTotalH * 0.72)
  const volTop = titleH + priceH + 6
  const volH = plotTotalH - priceH - 6

  const buckets = bucketBars(bars, Math.max(60, Math.floor(plotW)))
  const first = bars[0]!
  const last = bars[bars.length - 1]!

  const maxH = Math.max(...buckets.map((b) => b.high))
  const minL = Math.min(...buckets.map((b) => b.low))
  const pricePad = Math.max((maxH - minL) * 0.06, maxH * 1e-9 || 1e-12)
  const hi = maxH + pricePad
  const lo = Math.max(minL - pricePad, 0)
  const span = Math.max(hi - lo, 1e-12)
  const maxVol = Math.max(...buckets.map((b) => b.volume), 1e-9)

  const xFor = (i: number) => padL + (i / buckets.length) * plotW
  const yFor = (price: number) =>
    titleH + ((hi - price) / span) * priceH

  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-sans-serif,system-ui,sans-serif">`,
  )
  parts.push(`<rect width="${width}" height="${height}" fill="${BG}"/>`)

  if (opts.symbol?.trim()) {
    const chgPct =
      first.o > 0 ? ((last.c - first.o) / first.o) * 100 : null
    const changeColor =
      chgPct == null ? TEXT_DIM : chgPct >= 0 ? UP : DOWN
    parts.push(
      `<text x="${padL}" y="20" fill="${TEXT}" font-size="13" font-weight="600">${esc(opts.symbol.trim())} · ${esc(titleSuffix)}</text>`,
    )
    if (chgPct != null && Number.isFinite(chgPct)) {
      parts.push(
        `<text x="${width - padR}" y="20" fill="${changeColor}" font-size="13" font-weight="600" text-anchor="end">${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(1)}%</text>`,
      )
    }
  }

  // Gridlines + right price labels (5 bands).
  const bands = 5
  for (let i = 0; i <= bands; i++) {
    const frac = i / bands
    const price = hi - frac * span
    const y = titleH + frac * priceH
    parts.push(
      `<line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`,
    )
    parts.push(
      `<text x="${width - padR + 6}" y="${y + 4}" fill="${TEXT_DIM}" font-size="10">${fmtPrice(price)}</text>`,
    )
  }

  // Time labels at ~5 evenly spaced buckets.
  const timeStep = Math.max(1, Math.floor(buckets.length / 5))
  for (let i = 0; i < buckets.length; i += timeStep) {
    const b = buckets[i]!
    const x = xFor(i)
    parts.push(
      `<text x="${x}" y="${height - 7}" fill="${TEXT_DIM}" font-size="10" text-anchor="middle">${fmtTime(b.timeSec)}</text>`,
    )
  }

  // Candles + volume.
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i]!
    const x = xFor(i)
    const up = b.close >= b.open
    const color = up ? UP : DOWN
    const yH = yFor(b.high)
    const yL = yFor(b.low)
    const yO = yFor(b.open)
    const yC = yFor(b.close)
    const bodyTop = Math.min(yO, yC)
    const bodyH = Math.max(Math.abs(yC - yO), 1)
    const volX = x - 0.5
    const volHt = Math.max((b.volume / maxVol) * volH, b.volume > 0 ? 1 : 0)

    parts.push(
      `<line x1="${x}" x2="${x}" y1="${yH}" y2="${yL}" stroke="${color}" stroke-width="1"/>`,
    )
    parts.push(
      `<rect x="${x - 0.5}" y="${bodyTop}" width="1" height="${bodyH}" fill="${color}"/>`,
    )
    if (volHt > 0) {
      parts.push(
        `<rect x="${volX}" y="${volTop + (volH - volHt)}" width="1" height="${volHt}" fill="${color}" fill-opacity="0.45"/>`,
      )
    }
  }

  parts.push('</svg>')
  return parts.join('')
}

type SharpEncode = (input: Buffer) => {
  png: () => { toBuffer: () => Promise<Buffer> }
}

/**
 * True when the first bytes of `filePath` are a native addon this process can
 * dlopen. A Darwin Mach-O `sharp.node` copied into the Linux image segfaults
 * (exit 139) inside dlopen; refuse it before `import('sharp')`.
 */
export function isLoadableSharpNativeBinary(filePath: string): boolean {
  let fd: number | null = null
  try {
    fd = openSync(filePath, 'r')
    const magic = Buffer.alloc(4)
    const n = readSync(fd, magic, 0, 4, 0)
    if (n < 4) return false
    const os = platform()
    if (os === 'linux') {
      return (
        magic[0] === 0x7f &&
        magic[1] === 0x45 &&
        magic[2] === 0x4c &&
        magic[3] === 0x46
      )
    }
    if (os === 'darwin') {
      const hex = magic.toString('hex')
      return (
        hex === 'cffaedfe' ||
        hex === 'feedfacf' ||
        hex === 'cefaedfe' ||
        hex === 'feedface'
      )
    }
    return true
  } catch {
    return false
  } finally {
    if (fd != null) closeSync(fd)
  }
}

/** sharp's runtime id: `linux-x64`, `linuxmusl-x64`, `darwin-arm64`, … */
function sharpRuntimePlatform(): string | null {
  const os = platform()
  if (os !== 'linux' && os !== 'darwin' && os !== 'win32') return null
  let libc = ''
  if (os === 'linux') {
    try {
      const detectLibc = require('detect-libc') as {
        isNonGlibcLinuxSync: () => boolean
        familySync: () => string | null
      }
      if (detectLibc.isNonGlibcLinuxSync()) {
        libc = detectLibc.familySync() ?? ''
      }
    } catch {
      libc = ''
    }
  }
  return `${os}${libc}-${arch()}`
}

function sharpNativeNodeFiles(resolvedEntry: string): string[] {
  if (resolvedEntry.endsWith('.node')) return [resolvedEntry]
  try {
    return readdirSync(join(dirname(resolvedEntry), 'lib'))
      .filter((name) => name.endsWith('.node'))
      .map((name) => join(dirname(resolvedEntry), 'lib', name))
  } catch {
    return []
  }
}

/**
 * Resolve `@img/sharp-<platform>/sharp.node` without loading it. Missing or
 * wrong-format bindings skip the import so a Mac-traced Darwin binary is never
 * dlopen'd on Linux.
 */
function sharpNativeBindingIsLoadable(): boolean {
  const runtime = sharpRuntimePlatform()
  if (!runtime) return false
  let resolved: string
  try {
    resolved = require.resolve(`@img/sharp-${runtime}/sharp.node`)
  } catch {
    return false
  }
  const nodes = sharpNativeNodeFiles(resolved)
  return nodes.length > 0 && nodes.every((file) => isLoadableSharpNativeBinary(file))
}

function resolveSharpFactory(mod: unknown): SharpEncode | null {
  if (typeof mod === 'function') return mod as SharpEncode
  if (mod && typeof mod === 'object' && 'default' in mod) {
    const loaded = (mod as { default: unknown }).default
    if (typeof loaded === 'function') return loaded as SharpEncode
  }
  return null
}

async function loadSharpEncoder(): Promise<SharpEncode | null> {
  if (!sharpNativeBindingIsLoadable()) {
    console.warn(
      '[ohlc-telegram-svg] sharp native binding missing or wrong platform; chart PNG skipped',
    )
    return null
  }
  try {
    const mod = await import('sharp')
    const sharp = resolveSharpFactory(mod)
    if (!sharp) {
      console.warn(
        '[ohlc-telegram-svg] sharp export is not a function; chart PNG skipped',
      )
      return null
    }
    return sharp
  } catch (err) {
    console.warn(
      '[ohlc-telegram-svg] sharp load failed; chart PNG skipped',
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}

/** Rasterize SVG candles to PNG. Empty / sharp fail → null (never throws). */
export async function renderOhlcCandlesPng(
  bars: OhlcRugBar[],
  opts: OhlcSvgOpts = {},
): Promise<Buffer | null> {
  const svg = renderOhlcCandlesSvg(bars, opts)
  if (!svg) return null
  try {
    const sharp = await loadSharpEncoder()
    if (!sharp) return null
    return await sharp(Buffer.from(svg)).png().toBuffer()
  } catch (err) {
    console.warn(
      '[ohlc-telegram-svg] sharp PNG failed',
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}
