import { describe, expect, it, vi } from 'vitest'
import type { OhlcRugBar } from './ohlc-rug-rules'

vi.mock('sharp', () => ({
  get default() {
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

describe('renderOhlcCandlesPng sharp load', () => {
  it('rejects when sharp itself fails to load', async () => {
    await expect(
      renderOhlcCandlesPng(
        [bar(1, 1, 1.2, 0.9, 1.1), bar(2, 1.1, 1.3, 1.0, 0.95)],
        { symbol: 'DEMO' },
      ),
    ).rejects.toThrow(/linux-x64/)
  })

  it('does not touch sharp for an empty series', async () => {
    await expect(renderOhlcCandlesPng([])).resolves.toBeNull()
  })
})