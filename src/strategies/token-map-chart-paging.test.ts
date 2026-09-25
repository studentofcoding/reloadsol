import { describe, expect, it, vi, beforeEach } from 'vitest'

// fetchGmgnKlinePaged walks GMGN pages through the 0.5 rps gate. On a 24h x 1m
// window that is 16 pages x ~2s, which alone blew the 22s chart budget, so the
// walk now takes a deadline and bails after consecutive empty pages.

const { tokenKlineMock } = vi.hoisted(() => ({ tokenKlineMock: vi.fn() }))

vi.mock('@/utils/gmgn-api', () => ({ tokenKline: tokenKlineMock }))

import { fetchGmgnKlinePaged, ohlcIntervalForHours } from './token-map-chart'

const HOUR = 3600
const NOW = 1_790_320_000

function bar(time: number) {
  return { time, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }
}

describe('ohlcIntervalForHours', () => {
  it('picks the bar size from the span', () => {
    expect(ohlcIntervalForHours(6)).toBe('1m')
    expect(ohlcIntervalForHours(24)).toBe('5m')
    expect(ohlcIntervalForHours(48)).toBe('15m')
  })
})

describe('fetchGmgnKlinePaged', () => {
  beforeEach(() => {
    tokenKlineMock.mockReset()
  })

  it('returns the merged bars for a span that fits one page', async () => {
    tokenKlineMock.mockResolvedValue({ list: [bar(NOW - 300), bar(NOW - 60)] })

    const candles = await fetchGmgnKlinePaged({
      chain: 'sol',
      address: 'MINT',
      resolution: '5m',
      timeFrom: NOW - HOUR,
      timeTo: NOW,
    })

    expect(candles.map((c) => c.time)).toEqual([NOW - 300, NOW - 60])
    expect(tokenKlineMock).toHaveBeenCalledTimes(1)
  })

  it('stops the walk once the deadline is spent', async () => {
    tokenKlineMock.mockResolvedValue({ list: [bar(NOW - 300)] })

    const candles = await fetchGmgnKlinePaged({
      chain: 'sol',
      address: 'MINT',
      resolution: '1m',
      timeFrom: NOW - 24 * HOUR,
      timeTo: NOW,
      deadlineMs: -1,
    })

    expect(candles).toEqual([])
    expect(tokenKlineMock).not.toHaveBeenCalled()
  })

  it('bails after consecutive empty pages instead of paying the whole gate', async () => {
    tokenKlineMock.mockResolvedValue({ list: [] })

    const candles = await fetchGmgnKlinePaged({
      chain: 'sol',
      address: 'MINT',
      resolution: '1m',
      timeFrom: NOW - 24 * HOUR,
      timeTo: NOW,
      maxEmptyPages: 3,
    })

    expect(candles).toEqual([])
    // 16 pages would be the full walk; the empty bail stops at 3.
    expect(tokenKlineMock).toHaveBeenCalledTimes(3)
  })

  it('keeps bars already fetched when a later page throws', async () => {
    tokenKlineMock
      .mockResolvedValueOnce({ list: [bar(NOW - 300)] })
      .mockRejectedValueOnce(new Error('RATE_LIMIT'))

    const candles = await fetchGmgnKlinePaged({
      chain: 'sol',
      address: 'MINT',
      resolution: '1m',
      timeFrom: NOW - 24 * HOUR,
      timeTo: NOW,
    })

    expect(candles.map((c) => c.time)).toEqual([NOW - 300])
  })
})
