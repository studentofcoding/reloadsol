import { afterEach, describe, expect, it } from 'vitest'
import { scoreClosedLoopLogistic } from './entry-pattern-scorer'
import {
  CLOSED_LOOP_FEATURE_COLUMNS,
  bandOneHot,
  closedLoopLabelFromOutcome,
  collectClosedLoopTrainRows,
  extractClosedLoopFeaturesFromOutcome,
  extractClosedLoopFeaturesFromSnapshot,
  featureRecordToVector,
  heuristicClosedLoopScore,
  inferClosedLoopScore,
  isClosedLoopPrincipalId,
  isMlClosedLoopEnabled,
  parseClosedLoopModel,
  trainClosedLoopModel,
} from './closed-loop-ml'
import type { StrategyOutcomeRow } from './types'

afterEach(() => {
  delete process.env.ML_CLOSED_LOOP
})

function outcome(
  partial: Partial<StrategyOutcomeRow> & { id: string; strategy_id: string },
): StrategyOutcomeRow {
  return {
    domain: 'mcap_tracker',
    chain: 'sol',
    token_address: 'MintA',
    entry_at: '2026-09-01T00:00:00.000Z',
    exit_at: '2026-09-02T00:00:00.000Z',
    pnl_pct: 40,
    status: 'won',
    is_simulated: true,
    features: {},
    created_at: '2026-09-02T00:00:00.000Z',
    ...partial,
  }
}

describe('isMlClosedLoopEnabled', () => {
  it('is off by default and on only for 1/true/yes', () => {
    expect(isMlClosedLoopEnabled({})).toBe(false)
    expect(isMlClosedLoopEnabled({ ML_CLOSED_LOOP: '0' })).toBe(false)
    expect(isMlClosedLoopEnabled({ ML_CLOSED_LOOP: '1' })).toBe(true)
    expect(isMlClosedLoopEnabled({ ML_CLOSED_LOOP: 'true' })).toBe(true)
  })
})

describe('isClosedLoopPrincipalId', () => {
  it('accepts principal + RH aliases only', () => {
    expect(isClosedLoopPrincipalId('mcap_enter_first_seen')).toBe(true)
    expect(isClosedLoopPrincipalId('mcap_enter_at_80_rh')).toBe(true)
    expect(isClosedLoopPrincipalId('signals_default')).toBe(false)
  })
})

describe('bandOneHot / extract features', () => {
  it('one-hots a known mcap band', () => {
    const hot = bandOneHot('51-100k')
    expect(hot['band_51-100k']).toBe(1)
    expect(hot.band_under50k).toBe(0)
  })

  it('builds a snapshot vector from combined-score parts', () => {
    const rec = extractClosedLoopFeaturesFromSnapshot({
      parts: {
        principalScore: 1,
        adjusterPresenceScore: 0.5,
        jaccardScore: 0.4,
        ohlcPatternScore: 0.8,
      },
      combinedBase: 0.7,
      rugTrip: false,
      adjusters: [
        { domain: 'signals', present: true },
        { domain: 'gmgn', present: true },
        { domain: 'social', present: false },
        { domain: 'trending_bot', present: false },
      ],
      entryMcapBand: '101-200k',
      milestone80: true,
    })
    expect(rec['band_101-200k']).toBe(1)
    expect(rec.adjuster_presence).toBe(0.5)
    expect(rec.jaccard).toBe(0.4)
    expect(rec.combined).toBe(0.7)
    expect(rec.rug_trip).toBe(0)
    expect(rec.entry_template_milestone_80).toBe(1)
    expect(featureRecordToVector(rec)).toHaveLength(CLOSED_LOOP_FEATURE_COLUMNS.length)
  })

  it('imputes missing historical combined / jaccard / ohlc', () => {
    const rec = extractClosedLoopFeaturesFromOutcome({
      strategy_id: 'mcap_enter_at_80',
      features: { entry_mcap: 80_000 },
    })
    expect(rec['band_51-100k']).toBe(1)
    expect(rec.combined).toBe(0.5)
    expect(rec.jaccard).toBe(0)
    expect(rec.ohlc_pattern).toBe(0.5)
    expect(rec.entry_template_milestone_80).toBe(1)
  })
})

describe('closedLoopLabelFromOutcome', () => {
  it('prefers stored ml_win then recomputes gate class', () => {
    expect(
      closedLoopLabelFromOutcome({
        features: { ml_win: 1 },
        pnl_pct: -4,
        status: 'lost',
      }),
    ).toBe(1)
    expect(
      closedLoopLabelFromOutcome({
        features: {},
        pnl_pct: 40,
        status: 'won',
      }),
    ).toBe(1)
    expect(
      closedLoopLabelFromOutcome({
        features: {},
        pnl_pct: -10,
        status: 'lost',
      }),
    ).toBe(0)
  })
})

describe('collectClosedLoopTrainRows / train / infer', () => {
  it('skips non-principals and unlabeled rows', () => {
    const collected = collectClosedLoopTrainRows([
      outcome({ id: 's', strategy_id: 'signals_default' }),
      outcome({
        id: 'u',
        strategy_id: 'mcap_enter_first_seen',
        pnl_pct: null,
        status: 'open',
        features: {},
      }),
      outcome({
        id: 'p',
        strategy_id: 'mcap_enter_first_seen',
        pnl_pct: 40,
        status: 'won',
      }),
    ])
    expect(collected.skipped_not_principal).toBe(1)
    expect(collected.skipped_unlabeled).toBe(1)
    expect(collected.rows).toHaveLength(1)
    expect(collected.rows[0].label).toBe(1)
  })

  it('writes a heuristic artifact when n is below the floor', () => {
    const rows = collectClosedLoopTrainRows([
      outcome({ id: '1', strategy_id: 'mcap_enter_first_seen', pnl_pct: 40, status: 'won' }),
      outcome({ id: '2', strategy_id: 'mcap_enter_at_80', pnl_pct: -20, status: 'lost' }),
    ]).rows
    const model = trainClosedLoopModel(rows, {
      now: new Date('2026-09-20T12:00:00.000Z'),
      version: 'cl-test-h',
    })
    expect(model.model_type).toBe('heuristic')
    expect(model.version).toBe('cl-test-h')
    expect(model.metrics.n).toBe(2)
    const score = inferClosedLoopScore(rows[0].features, model)
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('fits a logistic model that ranks wins above losses', () => {
    const rows = []
    for (let i = 0; i < 6; i++) {
      rows.push({
        id: `w${i}`,
        strategy_id: 'mcap_enter_first_seen',
        label: 1 as const,
        features: extractClosedLoopFeaturesFromSnapshot({
          parts: {
            principalScore: 1,
            adjusterPresenceScore: 0.75,
            jaccardScore: 0.6,
            ohlcPatternScore: 0.9,
          },
          combinedBase: 0.8,
          rugTrip: false,
          milestone80: false,
          entryMcapBand: '101-200k',
        }),
      })
    }
    for (let i = 0; i < 6; i++) {
      rows.push({
        id: `l${i}`,
        strategy_id: 'mcap_enter_at_80',
        label: 0 as const,
        features: extractClosedLoopFeaturesFromSnapshot({
          parts: {
            principalScore: 0,
            adjusterPresenceScore: 0,
            jaccardScore: 0,
            ohlcPatternScore: 0,
          },
          combinedBase: 0.1,
          rugTrip: true,
          milestone80: true,
          entryMcapBand: 'under50k',
        }),
      })
    }
    const model = trainClosedLoopModel(rows, { version: 'cl-test-log' })
    expect(model.model_type).toBe('logistic')
    expect(model.weights.length).toBe(CLOSED_LOOP_FEATURE_COLUMNS.length)
    const win = inferClosedLoopScore(rows[0].features, model)
    const loss = inferClosedLoopScore(rows[6].features, model)
    expect(win).toBeGreaterThan(loss)
  })

  it('returns null for an invalid persisted blob', () => {
    expect(parseClosedLoopModel(null)).toBeNull()
    expect(parseClosedLoopModel({ version: 'x' })).toBeNull()
    const ok = parseClosedLoopModel({
      version: 'cl-1',
      model_type: 'heuristic',
      trainedAt: '2026-09-20T12:00:00.000Z',
      feature_columns: [...CLOSED_LOOP_FEATURE_COLUMNS],
      weights: [],
      bias: 0,
      principals_only: true,
      label: 'ml_win',
      metrics: { n: 0, positives: 0, negatives: 0 },
    })
    expect(ok?.version).toBe('cl-1')
  })
})

describe('scoreClosedLoopLogistic', () => {
  it('is 0.5 at zero logit and saturates at extremes', () => {
    expect(scoreClosedLoopLogistic([0], [0], 0)).toBeCloseTo(0.5)
    expect(scoreClosedLoopLogistic([1], [40], 0)).toBe(1)
    expect(scoreClosedLoopLogistic([1], [-40], 0)).toBe(0)
  })
})

describe('heuristicClosedLoopScore', () => {
  it('penalizes a rug trip', () => {
    const clean = heuristicClosedLoopScore({
      principal_score: 1,
      adjuster_presence: 1,
      jaccard: 1,
      ohlc_pattern: 1,
      rug_trip: 0,
    })
    const rugged = heuristicClosedLoopScore({
      principal_score: 1,
      adjuster_presence: 1,
      jaccard: 1,
      ohlc_pattern: 1,
      rug_trip: 1,
    })
    expect(clean).toBeGreaterThan(rugged)
  })
})
