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
  })
}
