import { describe, expect, it, vi } from 'vitest'
import type { TokenLocateResult } from '@/strategies/token-locate'
import type { TokenMapChartPayload } from '@/strategies/token-map-chart'
import {
  CLOSED_LOOP_FEATURE_COLUMNS,
  inferClosedLoopScore,
  type ClosedLoopModelArtifact,
} from '@/strategies/closed-loop-ml'
import {
  loadCombinedScore,
  scoreClosedLoopFromCombined,
} from '@/strategies/combined-score-load'

const MINT = 'So11111111111111111111111111111111111111112'
const NOW = Date.parse('2026-09-20T12:00:00.000Z')

function locateWithMcap(): TokenLocateResult {
  return {
    tokenAddress: MINT,
    symbol: 'SOL',
    found: true,
    strategyPresence: [
      {
        domain: 'mcap_tracker',
        strategyId: null,
        strategyName: null,
        source: 'token_mcap_tracking',
        label: 'potential',
      },
    ],
    locations: {
      trending: null,
      mcap: { present: true, label: 'potential' },
      signals: null,
      social: null,
      outcomes: { count: 0 },
      dlmmPotential: false,
      rugList: false,
      activeLockCount: 0,
    },
    rawSections: [],
    fetchedAt: '2026-09-20T12:00:00.000Z',
    links: {
      chart: '/chart',
      jupiter: 'https://jup.ag',
      signals: '/dev/signals',
      algoTester: '/dev/algo-tester',
      social: '/dev/social',
      strategies: '/dev/algo-tester?tab=closed',
      dlmm: '/dev/dlmm',
    },
  }
}

function emptyChart(): TokenMapChartPayload {
  return {
    tokenAddress: MINT,
    hours: 24,
    points: [],
    outcomes: [],
    candles: [],
    priceSource: 'empty',
    ohlcSource: 'none',
  }
}

const defaultWeights = {
  principal: 0.55,
  adjusterPresence: 0.2,
  jaccard: 0.15,
  ohlcPattern: 0.1,
}

function weightsDep(
  weights = defaultWeights,
  source: 'stored' | 'defaults' = 'defaults',
) {
  return vi.fn(async () => ({ weights, source }))
}

describe('loadCombinedScore', () => {
  it('returns success and principals for a mint with mcap presence', async () => {
    const payload = await loadCombinedScore({
      address: MINT,
      chain: 'sol',
      hours: 24,
      deps: {
        nowMs: NOW,
        locateTokenByAddress: vi.fn(async () => locateWithMcap()),
        loadTokenMapChart: vi.fn(async () => emptyChart()),
        fetchBrainOhlcPatterns: vi.fn(async () => ({
          ok: false as const,
          error: 'down',
          path: '/ohlc/patterns',
        })),
        fetchBrainOhlc: vi.fn(async () => ({
          ok: false as const,
          error: 'down',
          path: '/ohlc',
        })),
        loadCombinedScoreWeights: weightsDep(),
      },
    })

    expect(payload.success).toBe(true)
    expect(payload.mint).toBe(MINT)
    expect(payload.chain).toBe('sol')
    expect(payload.principals).toHaveLength(2)
    expect(payload.principals.every((row) => row.present)).toBe(true)
    expect(payload.parts.principalScore).toBe(0.3)
    expect(payload.parts.ohlcPatternScore).toBe(0.5)
    expect(payload.parts.jaccardScore).toBeNull()
  })

  it('fail-softs brain patterns to 0.5 and still succeeds', async () => {
    const payload = await loadCombinedScore({
      address: MINT,
      chain: 'sol',
      hours: 24,
      deps: {
        nowMs: NOW,
        locateTokenByAddress: vi.fn(async () => locateWithMcap()),
        loadTokenMapChart: vi.fn(async () => emptyChart()),
        fetchBrainOhlcPatterns: vi.fn(async () => {
          throw new Error('brain timeout')
        }),
        fetchBrainOhlc: vi.fn(async () => {
          throw new Error('brain timeout')
        }),
        loadCombinedScoreWeights: weightsDep(),
      },
    })

    expect(payload.success).toBe(true)
    expect(payload.parts.ohlcPatternScore).toBe(0.5)
    expect(payload.rugTrip).toBeUndefined()
  })

  it('prefers GET /ohlc/patterns when the brain answers', async () => {
    const fetchPatterns = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      data: {
        rug: {
          trip: false,
          features: {
            n: 10,
            dumpPct: 0,
            avgUpperWick: 0,
            wickTripBars: 0,
            volDeathRatio: 1,
          },
          hits: [],
        },
      },
    }))
    const fetchOhlc = vi.fn()

    const payload = await loadCombinedScore({
      address: MINT,
      chain: 'sol',
      hours: 24,
      deps: {
        nowMs: NOW,
        locateTokenByAddress: vi.fn(async () => locateWithMcap()),
        loadTokenMapChart: vi.fn(async () => emptyChart()),
        fetchBrainOhlcPatterns: fetchPatterns,
        fetchBrainOhlc: fetchOhlc,
        loadCombinedScoreWeights: weightsDep(),
      },
    })

    expect(fetchPatterns).toHaveBeenCalled()
    expect(fetchOhlc).not.toHaveBeenCalled()
    expect(payload.ohlcSource).toBe('brain:/ohlc/patterns')
    expect(payload.parts.ohlcPatternScore).toBe(1)
    expect(payload.rugTrip).toBe(false)
  })

  it('applies stored operator weights when present', async () => {
    const payload = await loadCombinedScore({
      address: MINT,
      chain: 'sol',
      hours: 24,
      deps: {
        nowMs: NOW,
        locateTokenByAddress: vi.fn(async () => locateWithMcap()),
        loadTokenMapChart: vi.fn(async () => emptyChart()),
        fetchBrainOhlcPatterns: vi.fn(async () => ({
          ok: false as const,
          error: 'down',
          path: '/ohlc/patterns',
        })),
        fetchBrainOhlc: vi.fn(async () => ({
          ok: false as const,
          error: 'down',
          path: '/ohlc',
        })),
        loadCombinedScoreWeights: weightsDep(
          {
            principal: 1,
            adjusterPresence: 0,
            jaccard: 0,
            ohlcPattern: 0,
          },
          'stored',
        ),
      },
    })

    expect(payload.parts.principalScore).toBe(0.3)
    expect(payload.weights.principal).toBe(1)
    expect(payload.combined).toBeCloseTo(0.3)
  })

  it('leaves combined unchanged when ML_CLOSED_LOOP is off', async () => {
    delete process.env.ML_CLOSED_LOOP
    const scoreClosedLoop = vi.fn(async () => ({ mlScore: 0.99, modelVersion: 'x' }))
    const payload = await loadCombinedScore({
      address: MINT,
      chain: 'sol',
      hours: 24,
      deps: {
        nowMs: NOW,
        locateTokenByAddress: vi.fn(async () => locateWithMcap()),
        loadTokenMapChart: vi.fn(async () => emptyChart()),
        fetchBrainOhlcPatterns: vi.fn(async () => ({
          ok: false as const,
          error: 'down',
          path: '/ohlc/patterns',
        })),
        fetchBrainOhlc: vi.fn(async () => ({
          ok: false as const,
          error: 'down',
          path: '/ohlc',
        })),
        loadCombinedScoreWeights: weightsDep(),
        scoreClosedLoop,
      },
    })
    expect(scoreClosedLoop).not.toHaveBeenCalled()
    expect(payload.mlScore).toBeNull()
    expect(payload.combined).toBeCloseTo(
      0.55 * 0.3 + 0.2 * 0 + 0.15 * 0 + 0.1 * 0.5,
    )
  })

  it('forwards locate current mcap into the closed-loop scorer', async () => {
    process.env.ML_CLOSED_LOOP = '1'
    const scoreClosedLoop = vi.fn(async () => ({ mlScore: 0.7, modelVersion: 'cl-1' }))
    const locate = locateWithMcap()
    locate.locations.mcap = {
      present: true,
      currentMcap: 180_000,
      firstMcap: 90_000,
    }
    try {
      await loadCombinedScore({
        address: MINT,
        chain: 'sol',
        hours: 24,
        deps: {
          nowMs: NOW,
          locateTokenByAddress: vi.fn(async () => locate),
          loadTokenMapChart: vi.fn(async () => emptyChart()),
          fetchBrainOhlcPatterns: vi.fn(async () => ({
            ok: false as const,
            error: 'down',
            path: '/ohlc/patterns',
          })),
          fetchBrainOhlc: vi.fn(async () => ({
            ok: false as const,
            error: 'down',
            path: '/ohlc',
          })),
          loadCombinedScoreWeights: weightsDep(),
          scoreClosedLoop,
        },
      })
      expect(scoreClosedLoop).toHaveBeenCalledWith(
        expect.objectContaining({ entryMcap: 180_000 }),
      )
    } finally {
      delete process.env.ML_CLOSED_LOOP
    }
  })
})

const BIAS_032 = Math.log(0.3201 / (1 - 0.3201))

function logisticModel(
  weightByColumn: Record<string, number>,
  bias = BIAS_032,
): ClosedLoopModelArtifact {
  return {
    version: 'cl-test-bias',
    model_type: 'logistic',
    trainedAt: '2026-09-24T00:00:00.000Z',
    feature_columns: [...CLOSED_LOOP_FEATURE_COLUMNS],
    weights: CLOSED_LOOP_FEATURE_COLUMNS.map((col) => weightByColumn[col] ?? 0),
    bias,
    principals_only: true,
    label: 'ml_win',
    metrics: { n: 100, positives: 32, negatives: 68 },
  }
}

/** Early-enter defaults: presence-only principal, brain fail-soft OHLC, no band. */
function earlyEnterPayload(entryMcap?: number) {
  return {
    payload: {
      parts: {
        principalScore: 0.3,
        adjusterPresenceScore: 0,
        jaccardScore: null as number | null,
        ohlcPatternScore: 0.5,
      },
      adjusters: [
        { domain: 'signals', present: false },
        { domain: 'gmgn', present: false },
        { domain: 'social', present: false },
        { domain: 'trending_bot', present: false },
      ],
      principals: [
        { strategyId: 'mcap_enter_first_seen', present: true },
        { strategyId: 'mcap_enter_at_80', present: false },
      ],
      combined: 0.55 * 0.3 + 0.1 * 0.5,
    },
    entryMcap,
  }
}

describe('scoreClosedLoopFromCombined', () => {
  it('a zero-weight logistic is sigmoid(bias) ≈ 0.32 and is not logged', () => {
    const model = logisticModel({})
    const { payload } = earlyEnterPayload()
    const raw = inferClosedLoopScore(
      {
        band_under50k: 0,
        'band_51-100k': 0,
        'band_101-200k': 0,
        'band_201-500k': 0,
        'band_501k-1M': 0,
        band_over1M: 0,
        adjuster_presence: 0,
        jaccard: 0,
        ohlc_pattern: 0.5,
        combined: payload.combined,
        rug_trip: 0,
        principal_score: 0.3,
        entry_template_milestone_80: 0,
      },
      model,
    )
    expect(raw).toBeCloseTo(0.3201, 4)

    const missingBand = scoreClosedLoopFromCombined(payload, { model })
    expect(missingBand.mlScore).toBeNull()
    expect(missingBand.modelVersion).toBe('cl-test-bias')

    const low = scoreClosedLoopFromCombined(payload, { model, entryMcap: 40_000 })
    const high = scoreClosedLoopFromCombined(payload, { model, entryMcap: 2_000_000 })
    expect(low.mlScore).toBeNull()
    expect(high.mlScore).toBeNull()
  })

  it('keeps per-band scores when the model actually uses entry mcap', () => {
    const model = logisticModel({
      band_under50k: 1.4,
      band_over1M: -1.6,
      entry_template_milestone_80: 0.8,
    })
    const { payload } = earlyEnterPayload()
    const small = scoreClosedLoopFromCombined(payload, {
      model,
      entryMcap: 40_000,
      milestone80: false,
    })
    const large = scoreClosedLoopFromCombined(payload, {
      model,
      entryMcap: 2_000_000,
      milestone80: true,
    })
    expect(small.mlScore).not.toBeNull()
    expect(large.mlScore).not.toBeNull()
    expect(small.mlScore!).toBeGreaterThan(0.55)
    expect(large.mlScore!).toBeLessThan(0.2)
    expect(Math.abs(small.mlScore! - large.mlScore!)).toBeGreaterThan(0.02)
  })

  it('still nulls a tiny residual around 0.32 when band weights are ~0', () => {
    const model = logisticModel({ ohlc_pattern: 0.02, combined: 0.01 })
    const { payload } = earlyEnterPayload()
    const a = scoreClosedLoopFromCombined(payload, { model, entryMcap: 40_000 })
    const b = scoreClosedLoopFromCombined(payload, { model, entryMcap: 800_000 })
    expect(a.mlScore).toBeNull()
    expect(b.mlScore).toBeNull()
  })
})
