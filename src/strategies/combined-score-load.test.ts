import { describe, expect, it, vi } from 'vitest'
import type { TokenLocateResult } from '@/strategies/token-locate'
import type { TokenMapChartPayload } from '@/strategies/token-map-chart'
import { loadCombinedScore } from '@/strategies/combined-score-load'

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
      strategies: '/dev/strategies',
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
})
