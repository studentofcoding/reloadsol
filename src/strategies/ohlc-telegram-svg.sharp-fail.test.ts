import { describe, expect, it, vi } from 'vitest'
import type { OhlcRugBar } from './ohlc-rug-rules'

vi.mock('sharp', () => ({
  default: () => {
    throw new Error(
      'Could not load the sharp module using the linux-x64 runtime',
    )
  },
}))

import { renderOhlcCandlesPng } from './ohlc-telegram-svg'

function bar(
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
): OhlcRugBar {
  return { t, o, h, l, c }
}

describe('renderOhlcCandlesPng sharp failure', () => {
  it('returns null when sharp loaded but PNG encode throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const png = await renderOhlcCandlesPng(
      [bar(1, 1, 1.2, 0.9, 1.1), bar(2, 1.1, 1.3, 1.0, 0.95)],
      { symbol: 'DEMO' },
    )
    expect(png).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
