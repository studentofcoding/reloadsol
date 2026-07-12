import { describe, expect, it } from 'vitest'
import {
  buildGmgnRadarReview,
  formatGmgnRadarTelegramHtml,
  scoreGmgnRadar,
} from './gmgn-radar-review'

describe('gmgn-radar-review', () => {
  it('matches screenshot-style WATCH for strong SM+KOL', () => {
    const review = buildGmgnRadarReview({
      sm: 37,
      kol: 46,
      holders: 3762,
      top10: 14,
      taxPct: 0,
      honeypot: false,
      liquidityUsd: 80_000,
    })
    expect(review.action).toBe('WATCH')
    expect(review.score).toBeGreaterThanOrEqual(45)
    expect(review.score).toBeLessThan(75)
    expect(review.gmgnLine).toContain('SM 37')
    expect(review.gmgnLine).toContain('KOL 46')
    expect(review.summary.toLowerCase()).toMatch(/tax|holder|smart|liquidity/)
  })

  it('matches screenshot-style SKIP for zero SM/KOL', () => {
    const review = buildGmgnRadarReview({
      sm: 0,
      kol: 0,
      holders: 892,
      top10: 17,
      taxPct: 0,
      liquidityUsd: 2_000,
      buySellReturnPct: 70,
    })
    expect(review.action).toBe('SKIP')
    expect(review.score).toBeLessThan(45)
    expect(review.summary.toLowerCase()).toMatch(/smart money|risky|slippage|liquidity/)
  })

  it('accepts top10 as fraction', () => {
    expect(scoreGmgnRadar({ sm: 10, kol: 5, top10: 0.14 })).toBe(
      scoreGmgnRadar({ sm: 10, kol: 5, top10: 14 }),
    )
  })

  it('formats telegram html card', () => {
    const review = buildGmgnRadarReview({ sm: 37, kol: 46, holders: 3762, top10: 14, taxPct: 0 })
    const html = formatGmgnRadarTelegramHtml({
      review,
      symbol: 'PEPE',
      tokenAddress: 'So11111111111111111111111111111111111111112',
      category: 'WALLET',
    })
    expect(html).toContain('Radar:')
    expect(html).toContain('GMGN:')
    expect(html).toContain('PEPE')
  })
})
