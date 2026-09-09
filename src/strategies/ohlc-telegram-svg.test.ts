import { describe, expect, it } from 'vitest'
import {
  renderOhlcCandlesPng,
  renderOhlcCandlesSvg,
} from './ohlc-telegram-svg'
import type { OhlcRugBar } from './ohlc-rug-rules'

function bar(
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
): OhlcRugBar {
  return { t, o, h, l, c }
}

describe('renderOhlcCandlesSvg', () => {
  it('returns null for empty bars', () => {
    expect(renderOhlcCandlesSvg([])).toBeNull()
  })

  it('renders candle rects and lines', () => {
    const svg = renderOhlcCandlesSvg(
      [
        bar(1, 1, 1.2, 0.9, 1.1),
        bar(2, 1.1, 1.3, 1.0, 1.05),
        bar(3, 1.05, 1.1, 0.8, 0.85),
      ],
      { symbol: 'TEST' },
    )
    expect(svg).toBeTruthy()
    expect(svg!).toContain('<svg')
    expect(svg!).toContain('<rect')
    expect(svg!).toContain('<line')
    expect(svg!).toContain('TEST')
    expect(svg!).toContain('24h OHLC')
    // lightweight-charts palette
    expect(svg!).toContain('#26a69a')
    expect(svg!).toContain('#ef5350')
  })

  it('renders full series beyond 10 bars', () => {
    const bars = Array.from({ length: 36 }, (_, i) =>
      bar(i, 1, 1.1, 0.9, i % 2 === 0 ? 1.05 : 0.95),
    )
    const svg = renderOhlcCandlesSvg(bars, { symbol: 'LONG' })
    expect(svg).toBeTruthy()
    // One wick line per candle (plus gridlines, which only add more).
    const lineCount = (svg!.match(/<line /g) ?? []).length
    expect(lineCount).toBeGreaterThanOrEqual(36)
    // One body rect per candle.
    const rectCount = (svg!.match(/<rect /g) ?? []).length
    expect(rectCount).toBeGreaterThanOrEqual(36)
  })

  it('rasterizes PNG via sharp', async () => {
    const png = await renderOhlcCandlesPng(
      [
        bar(1, 1, 1.2, 0.9, 1.1),
        bar(2, 1.1, 1.3, 1.0, 0.95),
      ],
      { symbol: 'DEMO' },
    )
    expect(png).toBeTruthy()
    expect(png!.length).toBeGreaterThan(100)
    // PNG magic
    expect(png!.subarray(0, 4).toString('hex')).toBe('89504e47')
  })
})
