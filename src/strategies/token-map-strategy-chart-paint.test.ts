import { describe, expect, it } from 'vitest'
import type { TokenChartOutcomeSegment } from '@/strategies/token-map-chart'
import type { TokenMapDomain } from '@/strategies/token-map-types'
import {
  domainAtTime,
  formatPriceLabel,
  meanPairwiseOverlapCorr,
  outcomeWindows,
  paintCandles,
  priceFormatFor,
} from '@/strategies/token-map-strategy-chart-paint'

describe('priceFormatFor / formatPriceLabel', () => {
  it('uses high precision for tiny meme prices', () => {
    const fmt = priceFormatFor(1.23e-7)
    expect(fmt.precision).toBeGreaterThanOrEqual(10)
    expect(formatPriceLabel(1.23e-7)).toMatch(/e-/i)
  })
})

describe('paintCandles', () => {
  it('grays uncovered bars and paints covered with domain color', () => {
    const windows = outcomeWindows(
      [
        {
          id: '1',
          domain: 'signals',
          strategyId: 's',
          status: 'won',
          pnlPct: 1,
          entryAt: '2026-07-19T01:00:00.000Z',
          exitAt: '2026-07-19T01:10:00.000Z',
          isSimulated: true,
        },
      ],
      new Set<TokenMapDomain>(['signals']),
    )
    const painted = paintCandles(
      [
        {
          time: Math.floor(new Date('2026-07-19T00:50:00.000Z').getTime() / 1000),
          open: 1,
          high: 1,
          low: 1,
          close: 1,
        },
        {
          time: Math.floor(new Date('2026-07-19T01:05:00.000Z').getTime() / 1000),
          open: 1,
          high: 1,
          low: 1,
          close: 1,
        },
      ],
      windows,
    )
    expect(painted[0]!.color).toBe('#6b7280')
    expect(painted[1]!.color).toBe('#60a5fa')
  })

  it('prefers mcap_tracker over signals on overlap', () => {
    const windows = outcomeWindows(
      [
        {
          id: '1',
          domain: 'signals',
          strategyId: 's',
          status: null,
          pnlPct: null,
          entryAt: '2026-07-19T01:00:00.000Z',
          exitAt: '2026-07-19T02:00:00.000Z',
          isSimulated: true,
        },
        {
          id: '2',
          domain: 'mcap_tracker',
          strategyId: 'm',
          status: null,
          pnlPct: null,
          entryAt: '2026-07-19T01:00:00.000Z',
          exitAt: '2026-07-19T02:00:00.000Z',
          isSimulated: true,
        },
      ],
      new Set<TokenMapDomain>(['signals', 'mcap_tracker']),
    )
    const t = Math.floor(new Date('2026-07-19T01:30:00.000Z').getTime() / 1000)
    expect(domainAtTime(t, windows)).toBe('mcap_tracker')
  })
})

describe('meanPairwiseOverlapCorr', () => {
  const base = (partial: Partial<TokenChartOutcomeSegment> & {
    id: string
    domain: TokenChartOutcomeSegment['domain']
    entryAt: string
    exitAt: string
  }): TokenChartOutcomeSegment => ({
    strategyId: 'x',
    status: null,
    pnlPct: null,
    isSimulated: true,
    ...partial,
  })

  it('returns null when windows do not overlap', () => {
    const corr = meanPairwiseOverlapCorr(
      [
        base({
          id: '1',
          domain: 'signals',
          entryAt: '2026-07-19T01:00:00.000Z',
          exitAt: '2026-07-19T01:10:00.000Z',
        }),
        base({
          id: '2',
          domain: 'gmgn',
          entryAt: '2026-07-19T03:00:00.000Z',
          exitAt: '2026-07-19T03:10:00.000Z',
        }),
      ],
      new Set<TokenMapDomain>(['signals', 'gmgn']),
    )
    expect(corr).toBeNull()
  })

  it('returns a score when windows overlap', () => {
    const corr = meanPairwiseOverlapCorr(
      [
        base({
          id: '1',
          domain: 'signals',
          entryAt: '2026-07-19T01:00:00.000Z',
          exitAt: '2026-07-19T02:00:00.000Z',
        }),
        base({
          id: '2',
          domain: 'gmgn',
          entryAt: '2026-07-19T01:30:00.000Z',
          exitAt: '2026-07-19T02:30:00.000Z',
        }),
      ],
      new Set<TokenMapDomain>(['signals', 'gmgn']),
    )
    expect(corr).not.toBeNull()
    expect(corr!).toBeGreaterThan(0)
    expect(corr!).toBeLessThanOrEqual(1)
  })
})
