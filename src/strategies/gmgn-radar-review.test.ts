import { describe, expect, it } from 'vitest'
import { accumulateRadarPeaks } from './gmgn-radar-accumulate'
import {
  buildGmgnRadarReview,
  deriveRadarThreadStage,
  formatGmgnRadarLiveThreadCaption,
  formatGmgnRadarLiveThreadHtml,
  formatGmgnRadarRugTelegramHtml,
  formatGmgnRadarTelegramHtml,
  resolveRadarTop10,
  scoreGmgnRadar,
} from './gmgn-radar-review'

describe('gmgn-radar-accumulate', () => {
  it('peaks SM/KOL/activity across poll + prior events', () => {
    const now = new Date('2026-07-13T03:00:00.000Z')
    const peaks = accumulateRadarPeaks({
      now,
      poll: { sm: 6, kol: 0, activityScore: 191 },
      events: [
        {
          source: 'gmgn_smartmoney',
          event_type: 'wallet_buy',
          occurred_at: '2026-07-13T01:46:00.000Z',
          raw_metadata: {
            sm_wallet_count_60m: 1,
            kol_wallet_count_60m: 0,
            gmgn_activity_score: 51,
          },
        },
        {
          source: 'gmgn_smartmoney',
          event_type: 'wallet_buy',
          occurred_at: '2026-07-13T02:15:00.000Z',
          raw_metadata: {
            sm_wallet_count_60m: 1,
            kol_wallet_count_60m: 0,
            gmgn_activity_score: 92,
          },
        },
        {
          source: 'signals_early',
          event_type: 'mention',
          occurred_at: '2026-07-13T01:36:00.000Z',
          raw_metadata: {
            early_signals_score: 54,
            early_growth_pct: 23.9,
          },
        },
      ],
    })
    expect(peaks.smPeak).toBe(6)
    expect(peaks.activityScorePeak).toBe(191)
    expect(peaks.earlySignalsScore).toBe(54)
    expect(peaks.hasEarlyEnter).toBe(true)
  })
})

describe('gmgn-radar-review recalibrated', () => {
  it('cold SM0 stays SKIP under 20', () => {
    const score = scoreGmgnRadar({ sm: 0, kol: 0 })
    expect(score).toBeLessThan(20)
    expect(buildGmgnRadarReview({ sm: 0, kol: 0 }).action).toBe('SKIP')
  })

  it('BISON-like SM6 + activity191 + early54 → ENTER ≥78', () => {
    const review = buildGmgnRadarReview({
      sm: 6,
      kol: 0,
      activityScore: 191,
      earlySignalsScore: 54,
      earlyGrowthPct: 23.9,
    })
    expect(review.score).toBeGreaterThanOrEqual(78)
    expect(review.action).toBe('ENTER')
    expect(review.summary.toLowerCase()).not.toMatch(/smart money present.*too risky/)
  })

  it('full stack can hit 100', () => {
    const score = scoreGmgnRadar({
      sm: 10,
      kol: 5,
      activityScore: 150,
      earlySignalsScore: 55,
      holders: 4000,
      top10: 12,
      buySellReturnPct: 98,
      honeypot: false,
    })
    expect(score).toBeGreaterThanOrEqual(95)
    expect(score).toBeLessThanOrEqual(100)
  })

  it('strong SM+KOL without activity/early still ≥WATCH', () => {
    const review = buildGmgnRadarReview({
      sm: 37,
      kol: 46,
      holders: 3762,
      top10: 14,
      honeypot: false,
    })
    expect(review.score).toBeGreaterThanOrEqual(45)
    expect(['WATCH', 'ENTER']).toContain(review.action)
  })

  it('SKIP with SM alone does not say too risky from SM', () => {
    const review = buildGmgnRadarReview({ sm: 2, kol: 0, activityScore: 10 })
    expect(review.action).toBe('SKIP')
    expect(review.summary.toLowerCase()).toMatch(/insufficient confirmation/)
    expect(review.summary.toLowerCase()).not.toMatch(/smart money present.*too risky/)
  })

  it('does not score tax or liquidity', () => {
    const a = scoreGmgnRadar({ sm: 5, kol: 2, taxPct: 0, liquidityUsd: 100_000 })
    const b = scoreGmgnRadar({ sm: 5, kol: 2, taxPct: 50, liquidityUsd: 100 })
    expect(a).toBe(b)
  })

  it('resolves top10 GMGN first then Jupiter', () => {
    expect(resolveRadarTop10({ gmgnTop10: 0.14, jupiterTop10Pct: 40 })).toEqual({
      top10: 0.14,
      top10Source: 'gmgn',
    })
    expect(resolveRadarTop10({ gmgnTop10: null, jupiterTop10Pct: 18 })).toEqual({
      top10: 18,
      top10Source: 'jupiter',
    })
  })

  it('gmgnLine shows jup tag and omits tax', () => {
    const review = buildGmgnRadarReview({
      sm: 3,
      kol: 1,
      top10: 18,
      top10Source: 'jupiter',
      taxPct: 5,
    })
    expect(review.gmgnLine).toContain('top10 18% (jup)')
    expect(review.gmgnLine.toLowerCase()).not.toContain('tax')
  })

  it('accepts top10 as fraction', () => {
    expect(scoreGmgnRadar({ sm: 10, kol: 5, top10: 0.14 })).toBe(
      scoreGmgnRadar({ sm: 10, kol: 5, top10: 14 }),
    )
  })

  it('boosts +15 when SM present and top10 < 20%', () => {
    const base = { sm: 5, kol: 0, activityScore: 40, holders: 2000 }
    const loose = scoreGmgnRadar({ ...base, top10: 25 })
    const tight = scoreGmgnRadar({ ...base, top10: 14 })
    // quality: top10≤20 → +4 vs top10≤35 → −10 ⇒ +14 quality delta, plus flat +15 boost
    expect(tight - loose).toBeGreaterThanOrEqual(15)
    const review = buildGmgnRadarReview({ ...base, top10: 14 })
    expect(review.reasons).toContain('top10 spread boost (+15)')
    expect(review.rawDebug?.boost).toBe(15)
  })

  it('does not apply SM top10 boost when sm=0 or top10≥20', () => {
    const noSm = buildGmgnRadarReview({ sm: 0, kol: 5, top10: 14 })
    expect(noSm.reasons).not.toContain('top10 spread boost (+15)')
    expect(noSm.rawDebug?.boost).toBe(0)

    const at20 = buildGmgnRadarReview({ sm: 5, kol: 0, top10: 20 })
    expect(at20.reasons).not.toContain('top10 spread boost (+15)')
    expect(at20.rawDebug?.boost).toBe(0)
  })

  it('formats telegram html card with price and mcap', () => {
    const review = buildGmgnRadarReview({ sm: 37, kol: 46, holders: 3762, top10: 14 })
    const html = formatGmgnRadarTelegramHtml({
      review,
      symbol: 'PEPE',
      tokenAddress: 'So11111111111111111111111111111111111111112',
      category: 'WALLET',
      priceUsd: 0.00012,
      mcapUsd: 48_200,
    })
    expect(html).toContain('Radar:')
    expect(html).toContain('GMGN:')
    expect(html).toContain('PEPE')
    expect(html).toContain('MC')
    expect(html).toContain('$48.2K')
    expect(html).toContain('<pre>')
    expect(html).toMatch(/top10Src=|boost=|holders=/)
  })

  it('formats rug telegram html', () => {
    const html = formatGmgnRadarRugTelegramHtml({
      symbol: 'RUGME',
      tokenAddress: 'So11111111111111111111111111111111111111112',
      previousMcapUsd: 80_000,
      currentMcapUsd: 20_000,
      priceUsd: 0.00001,
      reason: 'WATCH mcap rug',
    })
    expect(html).toContain('RUG')
    expect(html).toContain('$80.0K')
    expect(html).toContain('$20.0K')
    expect(html).toContain('WATCH mcap rug')
  })

  it('formats live thread with initial, peaks, and pct vs last', () => {
    const review = buildGmgnRadarReview({ sm: 10, kol: 5, top10: 14 })
    const html = formatGmgnRadarLiveThreadHtml({
      kind: 'new',
      review,
      symbol: 'WUKONG',
      tokenAddress: 'So11111111111111111111111111111111111111112',
      category: 'HOT',
      lifecycle: 1,
      peakSm: 12,
      peakKol: 8,
      initialPriceUsd: 0.0001,
      initialMcapUsd: 37_300,
      priceUsd: 0.00015,
      mcapUsd: 50_000,
      pricePctVsLast: 10,
      mcapPctVsLast: 8.5,
      pricePctVsInitial: 50,
      mcapPctVsInitial: 34.0,
      openedAt: new Date().toISOString(),
      peakMcapUsd: 55_000,
      ohlcPre: '<pre>▁▃▅▇\n1→2 · +10.0% · 4b</pre>',
    })
    expect(html).toContain('SURGE')
    expect(html).toContain('Initial:')
    expect(html).toContain('$37.3K')
    expect(html).toContain('Peak MC')
    expect(html).toContain('Age:')
    expect(html).toContain('SM')
    expect(html).toContain('12')
    expect(html).toContain('KOL')
    expect(html).toContain('+10.0%')
    expect(html).toContain('Δ vs last')
    expect(html).toContain('OHLC 24h')
    expect(html).toContain('<pre>')
    expect(html).toMatch(/boost=15|top10Pct=/)
  })

  it('deriveRadarThreadStage covers fresh tracking surge fade', () => {
    const now = Date.now()
    expect(
      deriveRadarThreadStage({
        openedAt: new Date(now - 5 * 60_000).toISOString(),
        mcapPctVsInitial: 0,
        peakSm: 1,
        radarAction: 'WATCH',
        nowMs: now,
      }),
    ).toBe('fresh')
    expect(
      deriveRadarThreadStage({
        openedAt: new Date(now - 40 * 60_000).toISOString(),
        mcapPctVsInitial: 10,
        peakSm: 2,
        radarAction: 'WATCH',
        nowMs: now,
      }),
    ).toBe('tracking')
    expect(
      deriveRadarThreadStage({
        openedAt: new Date(now - 5 * 60_000).toISOString(),
        mcapPctVsInitial: 60,
        peakSm: 1,
        radarAction: 'WATCH',
        nowMs: now,
      }),
    ).toBe('surge')
    expect(
      deriveRadarThreadStage({
        openedAt: new Date(now - 40 * 60_000).toISOString(),
        mcapPctVsInitial: -50,
        peakSm: 1,
        radarAction: 'WATCH',
        nowMs: now,
      }),
    ).toBe('fade')
  })

  it('formats compact photo caption under 1024 without rawDebug', () => {
    const review = buildGmgnRadarReview({ sm: 10, kol: 5, top10: 14 })
    const caption = formatGmgnRadarLiveThreadCaption({
      kind: 'new',
      review,
      symbol: 'WUKONG',
      tokenAddress: 'So11111111111111111111111111111111111111112',
      category: 'HOT',
      lifecycle: 1,
      peakSm: 12,
      peakKol: 8,
      initialPriceUsd: 0.0001,
      initialMcapUsd: 37_300,
      priceUsd: 0.00015,
      mcapUsd: 50_000,
      openedAt: new Date().toISOString(),
    })
    expect(caption.length).toBeLessThanOrEqual(1024)
    expect(caption).toContain('Radar:')
    expect(caption).toContain('WUKONG')
    expect(caption).not.toContain('boost=')
    expect(caption).not.toContain('OHLC 24h')
  })

  it('formats dead thread without removing lifecycle context', () => {
    const review = buildGmgnRadarReview({ sm: 3, kol: 1 })
    const html = formatGmgnRadarLiveThreadHtml({
      kind: 'dead',
      review,
      symbol: 'WUKONG',
      tokenAddress: 'mint',
      category: 'HOT',
      lifecycle: 1,
      peakSm: 12,
      peakKol: 8,
      initialPriceUsd: 0.0001,
      initialMcapUsd: 80_000,
      priceUsd: 0.00002,
      mcapUsd: 15_000,
      pricePctVsLast: -50,
      mcapPctVsLast: -60,
      deathReason: 'drawdown 81%',
    })
    expect(html).toContain('RUG / DEAD')
    expect(html).toContain('drawdown 81%')
    expect(html).toContain('Lifecycle #1')
  })
})
