/**
 * I/O for GET /api/strategies/combined-score.
 *
 * ponytail: locate / chart / brain are fail-soft so a valid mint still
 * returns success. Brain miss → ohlcPatternScore 0.5. Rug trip never
 * throws and never blocks the payload.
 */
import { locateTokenByAddress, type TokenLocateResult } from '@/strategies/token-locate'
import { loadTokenMapChart, type TokenChartOutcomeSegment } from '@/strategies/token-map-chart'
import {
  COMBINED_SCORE_WEIGHTS,
  assembleCombinedScore,
  type CombinedScoreChain,
  type CombinedScoreLocateInput,
  type CombinedScoreResponse,
  type CombinedScoreWeights,
} from '@/strategies/combined-score'
import { loadCombinedScoreWeights } from '@/strategies/combined-score-weights'
import {
  extractClosedLoopFeaturesFromSnapshot,
  inferClosedLoopScore,
  isMlClosedLoopEnabled,
} from '@/strategies/closed-loop-ml'
import { loadClosedLoopModel } from '@/strategies/closed-loop-ml-cache'
import {
  fetchBrainOhlc,
  fetchBrainOhlcPatterns,
  type BrainOhlcPatternSummary,
  type MarketBrainFetchOpts,
} from '@/utils/market-brain'

export type CombinedScoreLoadDeps = {
  locateTokenByAddress?: typeof locateTokenByAddress
  loadTokenMapChart?: typeof loadTokenMapChart
  fetchBrainOhlcPatterns?: typeof fetchBrainOhlcPatterns
  fetchBrainOhlc?: typeof fetchBrainOhlc
  loadCombinedScoreWeights?: typeof loadCombinedScoreWeights
  scoreClosedLoop?: (input: {
    parts: CombinedScoreResponse['parts']
    adjusters: CombinedScoreResponse['adjusters']
    principals: CombinedScoreResponse['principals']
    combined: number
    rugTrip?: boolean
  }) => Promise<{ mlScore: number | null; modelVersion: string | null }>
  nowMs?: number
}

function toLocateInput(result: TokenLocateResult): CombinedScoreLocateInput {
  return {
    strategyPresence: result.strategyPresence,
    locations: {
      trending: result.locations.trending,
      mcap: result.locations.mcap,
      signals: result.locations.signals,
      social: result.locations.social,
    },
  }
}

async function loadOhlcPatterns(
  mint: string,
  chain: CombinedScoreChain,
  hours: number,
  deps: CombinedScoreLoadDeps,
  brainOpts?: MarketBrainFetchOpts,
): Promise<{
  patterns: BrainOhlcPatternSummary | null
  failed: boolean
  source?: string
}> {
  const fetchPatterns = deps.fetchBrainOhlcPatterns ?? fetchBrainOhlcPatterns
  const fetchOhlc = deps.fetchBrainOhlc ?? fetchBrainOhlc
  const query = { mint, chain, hours }

  try {
    const direct = await fetchPatterns(query, brainOpts)
    if (direct.ok) {
      return {
        patterns: direct.data,
        failed: false,
        source: 'brain:/ohlc/patterns',
      }
    }
  } catch {
    /* try nested include=patterns */
  }

  try {
    const nested = await fetchOhlc({ ...query, includePatterns: true }, brainOpts)
    if (nested.ok && nested.data.patterns) {
      return {
        patterns: nested.data.patterns,
        failed: false,
        source: 'brain:/ohlc?include=patterns',
      }
    }
  } catch {
    /* fail-soft */
  }

  return { patterns: null, failed: true }
}

export async function loadCombinedScore(params: {
  address: string
  chain: CombinedScoreChain
  hours: number
  deps?: CombinedScoreLoadDeps
  brain?: MarketBrainFetchOpts
}): Promise<CombinedScoreResponse> {
  const deps = params.deps ?? {}
  const nowMs = deps.nowMs ?? Date.now()
  const locateFn = deps.locateTokenByAddress ?? locateTokenByAddress
  const chartFn = deps.loadTokenMapChart ?? loadTokenMapChart

  let locate: CombinedScoreLocateInput | null = null
  try {
    locate = toLocateInput(
      await locateFn(params.address, { chain: params.chain }),
    )
  } catch {
    locate = null
  }

  let outcomes: TokenChartOutcomeSegment[] = []
  try {
    const chart = await chartFn({
      tokenAddress: params.address,
      hours: params.hours,
      chain: params.chain,
    })
    outcomes = chart.outcomes
  } catch {
    outcomes = []
  }

  const ohlc = await loadOhlcPatterns(
    params.address,
    params.chain,
    params.hours,
    deps,
    params.brain,
  )

  let weights: CombinedScoreWeights = { ...COMBINED_SCORE_WEIGHTS }
  try {
    const loadWeights = deps.loadCombinedScoreWeights ?? loadCombinedScoreWeights
    weights = (await loadWeights()).weights
  } catch {
    weights = { ...COMBINED_SCORE_WEIGHTS }
  }

  const base = assembleCombinedScore({
    mint: params.address,
    chain: params.chain,
    hours: params.hours,
    nowMs,
    locate,
    outcomes,
    ohlcPatterns: ohlc.patterns,
    ohlcFailed: ohlc.failed,
    ohlcSource: ohlc.source,
    weights,
  })

  if (!isMlClosedLoopEnabled()) {
    return { ...base, mlScore: null, modelVersion: null }
  }

  let mlScore: number | null = null
  let modelVersion: string | null = null
  try {
    const scored = deps.scoreClosedLoop
      ? await deps.scoreClosedLoop({
          parts: base.parts,
          adjusters: base.adjusters,
          principals: base.principals,
          combined: base.combined,
          rugTrip: base.rugTrip,
        })
      : scoreClosedLoopFromCombined(base)
    mlScore = scored.mlScore
    modelVersion = scored.modelVersion
  } catch {
    mlScore = null
    modelVersion = null
  }

  return assembleCombinedScore({
    mint: params.address,
    chain: params.chain,
    hours: params.hours,
    nowMs,
    locate,
    outcomes,
    ohlcPatterns: ohlc.patterns,
    ohlcFailed: ohlc.failed,
    ohlcSource: ohlc.source,
    weights,
    mlScore,
    modelVersion,
    generatedAt: base.generatedAt,
  })
}

export function scoreClosedLoopFromCombined(
  payload: Pick<
    CombinedScoreResponse,
    'parts' | 'adjusters' | 'principals' | 'combined' | 'rugTrip'
  >,
): { mlScore: number | null; modelVersion: string | null } {
  const model = loadClosedLoopModel()
  if (!model) return { mlScore: null, modelVersion: null }
  const milestone80 = payload.principals.some(
    (row) => row.strategyId === 'mcap_enter_at_80' && row.present,
  )
  const features = extractClosedLoopFeaturesFromSnapshot({
    parts: payload.parts,
    combinedBase: payload.combined,
    rugTrip: payload.rugTrip,
    adjusters: payload.adjusters,
    milestone80,
  })
  return {
    mlScore: inferClosedLoopScore(features, model),
    modelVersion: model.version,
  }
}
