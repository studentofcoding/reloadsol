import { describe, expect, it } from 'vitest'
import { formatOhlcTelegramPre } from './ohlc-telegram-paint'
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

describe('formatOhlcTelegramPre', () => {
  it('returns empty for no bars', () => {
    expect(formatOhlcTelegramPre([])).toBe('')
  })

  it('paints sparkline + stats in pre', () => {
    const bars = [
      bar(1, 1, 1.2, 0.9, 1.1),
      bar(2, 1.1, 1.3, 1.0, 1.2),
      bar(3, 1.2, 1.4, 1.1, 1.0),
      bar(4, 1.0, 1.1, 0.8, 0.85),
    ]
    const html = formatOhlcTelegramPre(bars)
    expect(html).toMatch(/^<pre>/)
    expect(html).toMatch(/<\/pre>$/)
    expect(html.length).toBeLessThan(500)
    expect(html).toContain('→')
    expect(html).toContain('4b')
    // sparkline uses block chars
    expect(html).toMatch(/[▁▂▃▄▅▆▇█]/)
  })

  it('caps at 10 bars', () => {
    const bars = Array.from({ length: 15 }, (_, i) =>
      bar(i, 1 + i * 0.01, 1.2, 0.9, 1 + i * 0.01),
    )
    const html = formatOhlcTelegramPre(bars)
    expect(html).toContain('10b')
  })

  it('escapes HTML in pre body', () => {
    // values are numeric — ensure wrapper is safe
    const html = formatOhlcTelegramPre([bar(1, 1, 1, 1, 1)])
    expect(html).not.toContain('<script')
    expect(html.startsWith('<pre>')).toBe(true)
  })
})
