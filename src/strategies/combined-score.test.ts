import { describe, expect, it } from 'vitest'
import type { TokenChartOutcomeSegment } from '@/strategies/token-map-chart'
import type { BrainOhlcPatternSummary } from '@/utils/market-brain'
import {
  ADJUSTER_DOMAINS,
  COMBINED_SCORE_WEIGHTS,
  assembleCombinedScore,
  clamp01,
  combineParts,
  jaccardScoreForFormula,
  scoreAdjusterPresence,
  scoreOhlcPattern,
  scorePrincipal,
} from '@/strategies/combined-score'

function outcome(
  partial: Partial<TokenChartOutcomeSegment> & {
    id: string
    strategyId: string
    domain?: TokenChartOutcomeSegment['domain']
  },
): TokenChartOutcomeSegment {
  return {
    domain: 'mcap_tracker',
    status: null,
    pnlPct: null,
    entryAt: null,
    exitAt: null,
    isSimulated: true,
    ...partial,
  }
}

function patterns(
  trip: boolean,
  features: Partial<BrainOhlcPatternSummary['rug']['features']> = {},
): BrainOhlcPatternSummary {
  return {
    rug: {
      trip,
      features: {
        n: features.n ?? 10,
        dumpPct: features.dumpPct ?? null,
        avgUpperWick: features.avgUpperWick ?? null,
        wickTripBars: features.wickTripBars ?? 0,
        volDeathRatio: features.volDeathRatio ?? null,
      },
      hits: [],
    },
  }
}

const NOW = Date.parse('2026-09-20T12:00:00.000Z')

describe('COMBINED_SCORE_WEIGHTS', () => {
  it('sums to 1', () => {
    const sum =
      COMBINED_SCORE_WEIGHTS.principal +
      COMBINED_SCORE_WEIGHTS.adjusterPresence +
      COMBINED_SCORE_WEIGHTS.jaccard +
      COMBINED_SCORE_WEIGHTS.ohlcPattern
    expect(sum).toBeCloseTo(1, 10)
    expect(COMBINED_SCORE_WEIGHTS.principal).toBe(0.55)
    expect(COMBINED_SCORE_WEIGHTS.adjusterPresence).toBe(0.2)
    expect(COMBINED_SCORE_WEIGHTS.jaccard).toBe(0.15)
    expect(COMBINED_SCORE_WEIGHTS.ohlcPattern).toBe(0.1)
  })
})

describe('clamp01', () => {
  it('clamps below 0, above 1, and non-finite to the unit interval', () => {
    expect(clamp01(-0.2)).toBe(0)
    expect(clamp01(1.4)).toBe(1)
    expect(clamp01(0.42)).toBe(0.42)
    expect(clamp01(Number.NaN)).toBe(0)
    expect(clamp01(Number.NEGATIVE_INFINITY)).toBe(0)
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe('scoreOhlcPattern', () => {
  it('returns 0 on rug trip', () => {
    expect(scoreOhlcPattern(patterns(true, { dumpPct: 0.1 }))).toBe(0)
  })

  it('returns 0.5 fail-soft when patterns are missing or brain failed', () => {
    expect(scoreOhlcPattern(null)).toBe(0.5)
    expect(scoreOhlcPattern(undefined)).toBe(0.5)
    expect(scoreOhlcPattern(patterns(false), { failed: true })).toBe(0.5)
  })

  it('maps dump / wick / vol-death into softness', () => {
    expect(scoreOhlcPattern(patterns(false, { dumpPct: 0.4 }))).toBe(0)
    expect(scoreOhlcPattern(patterns(false, { dumpPct: 0.2 }))).toBeCloseTo(0.5)
    expect(scoreOhlcPattern(patterns(false, { avgUpperWick: 0.6 }))).toBe(0)
    expect(scoreOhlcPattern(patterns(false, { volDeathRatio: 0 }))).toBe(0)
    expect(scoreOhlcPattern(patterns(false, { dumpPct: 0, avgUpperWick: 0, volDeathRatio: 1 }))).toBe(
      1,
    )
  })
})

describe('jaccardScoreForFormula', () => {
  it('treats null (fewer than 2 overlapping domains) as 0', () => {
    expect(jaccardScoreForFormula(null)).toBe(0)
    expect(jaccardScoreForFormula(0.4)).toBe(0.4)
  })
})

describe('scoreAdjusterPresence', () => {
  it('is 1/4 per present adjuster domain', () => {
    expect(scoreAdjusterPresence(new Set())).toBe(0)
    expect(scoreAdjusterPresence(new Set(['signals']))).toBe(0.25)
    expect(scoreAdjusterPresence(new Set(ADJUSTER_DOMAINS))).toBe(1)
    expect(scoreAdjusterPresence(new Set(['dlmm', 'signals']))).toBe(0.25)
  })
})

describe('scorePrincipal', () => {
  it('scores 1.0 for an open principal window overlapping now', () => {
    expect(
      scorePrincipal({
        nowMs: NOW,
        hours: 24,
        presence: false,
        outcomes: [
          outcome({
            id: '1',
            strategyId: 'mcap_enter_first_seen',
            status: 'open',
            entryAt: '2026-09-20T11:00:00.000Z',
            exitAt: null,
          }),
        ],
      }),
    ).toBe(1)
  })

  it('scores 1.0 for a won window overlapping now, including _rh ids', () => {
    expect(
      scorePrincipal({
        nowMs: NOW,
        hours: 24,
        presence: false,
        outcomes: [
          outcome({
            id: '1',
            strategyId: 'mcap_enter_at_80_rh',
            status: 'won',
            pnlPct: 12,
            entryAt: '2026-09-20T10:00:00.000Z',
            exitAt: '2026-09-20T13:00:00.000Z',
          }),
        ],
      }),
    ).toBe(1)
  })

  it('scores 0.6 for a closed outcome in-window with pnl ≥ 0', () => {
    expect(
      scorePrincipal({
        nowMs: NOW,
        hours: 24,
        presence: true,
        outcomes: [
          outcome({
            id: '1',
            strategyId: 'mcap_enter_first_seen',
            status: 'lost',
            pnlPct: 0,
            entryAt: '2026-09-20T08:00:00.000Z',
            exitAt: '2026-09-20T09:00:00.000Z',
          }),
        ],
      }),
    ).toBe(0.6)
  })

  it('scores 0.3 for mcap presence only', () => {
    expect(
      scorePrincipal({
        nowMs: NOW,
        hours: 24,
        presence: true,
        outcomes: [],
      }),
    ).toBe(0.3)
  })

  it('scores 0 when nothing is present', () => {
    expect(
      scorePrincipal({
        nowMs: NOW,
        hours: 24,
        presence: false,
        outcomes: [],
      }),
    ).toBe(0)
  })
})

describe('combineParts / assembleCombinedScore', () => {
  it('uses 0 for a null Jaccard in the weighted formula', () => {
    const combined = combineParts({
      principalScore: 1,
      adjusterPresenceScore: 0,
      jaccardScore: null,
      ohlcPatternScore: 0,
    })
    expect(combined).toBeCloseTo(0.55)
  })

  it('returns the SPEC payload with mcap presence and a null Jaccard', () => {
    const payload = assembleCombinedScore({
      mint: 'So11111111111111111111111111111111111111112',
      chain: 'sol',
      hours: 24,
      nowMs: NOW,
      generatedAt: '2026-09-20T12:00:00.000Z',
      locate: {
        strategyPresence: [
          {
            domain: 'mcap_tracker',
            strategyId: null,
            strategyName: null,
            source: 'token_mcap_tracking',
          },
        ],
        locations: {
          trending: null,
          mcap: { present: true },
          signals: null,
          social: null,
        },
      },
      outcomes: [],
      ohlcPatterns: null,
      ohlcFailed: true,
    })

    expect(payload.success).toBe(true)
    expect(payload.parts.principalScore).toBe(0.3)
    expect(payload.parts.adjusterPresenceScore).toBe(0)
    expect(payload.parts.jaccardScore).toBeNull()
    expect(payload.parts.ohlcPatternScore).toBe(0.5)
    expect(payload.combined).toBeCloseTo(0.55 * 0.3 + 0.1 * 0.5)
    expect(payload.principals).toEqual([
      { strategyId: 'mcap_enter_first_seen', present: true },
      { strategyId: 'mcap_enter_at_80', present: true },
    ])
    expect(payload.adjusters.every((row) => row.present === false)).toBe(true)
    expect(payload.rugTrip).toBeUndefined()
  })

  it('computes a non-null Jaccard when two enabled domains overlap', () => {
    const payload = assembleCombinedScore({
      mint: 'MintA',
      chain: 'sol',
      hours: 24,
      nowMs: NOW,
      locate: {
        strategyPresence: [],
        locations: {
          trending: null,
          mcap: { present: true },
          signals: { present: true },
          social: null,
        },
      },
      outcomes: [
        outcome({
          id: 'm',
          domain: 'mcap_tracker',
          strategyId: 'mcap_enter_first_seen',
          status: 'open',
          entryAt: '2026-09-20T11:00:00.000Z',
          exitAt: null,
        }),
        outcome({
          id: 's',
          domain: 'signals',
          strategyId: 'signals_default',
          status: 'open',
          entryAt: '2026-09-20T11:10:00.000Z',
          exitAt: null,
        }),
      ],
      ohlcPatterns: patterns(false, { dumpPct: 0, avgUpperWick: 0, volDeathRatio: 1 }),
    })

    expect(payload.parts.jaccardScore).not.toBeNull()
    expect(payload.parts.jaccardScore!).toBeGreaterThan(0)
    expect(payload.parts.principalScore).toBe(1)
    expect(payload.combined).toBeGreaterThan(0.55)
  })

  it('sets rugTrip and zeroes the OHLC part without blocking the score', () => {
    const payload = assembleCombinedScore({
      mint: 'MintA',
      chain: 'sol',
      hours: 24,
      nowMs: NOW,
      locate: {
        strategyPresence: [],
        locations: {
          trending: null,
          mcap: { present: true },
          signals: { present: true },
          social: null,
        },
      },
      outcomes: [
        outcome({
          id: 'sig',
          domain: 'signals',
          strategyId: 'signals_default',
          entryAt: '2026-09-20T11:00:00.000Z',
          exitAt: '2026-09-20T11:30:00.000Z',
        }),
      ],
      ohlcPatterns: patterns(true, { dumpPct: 0.9 }),
      ohlcSource: 'brain:/ohlc/patterns',
    })

    expect(payload.parts.ohlcPatternScore).toBe(0)
    expect(payload.rugTrip).toBe(true)
    expect(payload.ohlcSource).toBe('brain:/ohlc/patterns')
    expect(payload.combined).toBeGreaterThan(0)
    expect(payload.adjusters.find((row) => row.domain === 'signals')?.present).toBe(true)
  })
})
