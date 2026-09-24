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
  isInterceptOnlyClosedLoopScore,
  isMlClosedLoopEnabled,
  type ClosedLoopModelArtifact,
} from '@/strategies/closed-loop-ml'
import { computeEntryMcapBand } from '@/strategies/outcome-features'
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
    entryMcap?: number | null
    milestone80?: boolean
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

/** Live mcap for the closed-loop band. Current fill wins over first-seen. */
export function readLocateEntryMcap(
  locate: CombinedScoreLocateInput | null,
): number | null {
  const mcap = locate?.locations.mcap
  if (!mcap) return null
  const current = mcap.currentMcap
  if (typeof current === 'number' && Number.isFinite(current) && current > 0) return current
  const first = mcap.firstMcap
  if (typeof first === 'number' && Number.isFinite(first) && first > 0) return first
  return null
}

function finitePositive(value: number | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  return null
}

export async function loadCombinedScore(params: {
  address: string
  chain: CombinedScoreChain
  hours: number
  /** Freeview: match Strategy correlation OHLC window. */
  window?: 'auto' | 'fixed'
  /** Early Enter entry mcap. Overrides the locate row when set. */
  entryMcap?: number | null
  /** Early Enter arm: growth ≥ 80. Omit to infer from an open at_80 principal. */
  milestone80?: boolean
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
  let chartHours = params.hours
  try {
    const chart = await chartFn({
      tokenAddress: params.address,
      hours: params.hours,
      chain: params.chain,
      ...(params.window === 'auto' ? { window: 'auto' as const } : {}),
    })
    outcomes = chart.outcomes
    if (params.window === 'auto' && Number.isFinite(chart.hours)) {
      chartHours = Math.max(1, Math.ceil(chart.hours))
    }
  } catch {
    outcomes = []
  }

  const ohlc = await loadOhlcPatterns(
    params.address,
    params.chain,
    chartHours,
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

  const entryMcap = finitePositive(params.entryMcap) ?? readLocateEntryMcap(locate)

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
          entryMcap,
          milestone80: params.milestone80,
        })
      : scoreClosedLoopFromCombined(base, {
          entryMcap,
          milestone80: params.milestone80,
        })
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

export type ClosedLoopScoreContext = {
  /** Entry mcap at the decision. Missing → band one-hots stay 0. */
  entryMcap?: number | null
  /** When set, overrides “at_80 principal already open”. */
  milestone80?: boolean
  /**
   * Pass a model in tests. `undefined` loads the artifact.
   * Explicit `null` means the model is unavailable.
   */
  model?: ClosedLoopModelArtifact | null
}

export function scoreClosedLoopFromCombined(
  payload: Pick<
    CombinedScoreResponse,
    'parts' | 'adjusters' | 'principals' | 'combined' | 'rugTrip'
  >,
  ctx?: ClosedLoopScoreContext,
): { mlScore: number | null; modelVersion: string | null } {
  const model = ctx?.model !== undefined ? ctx.model : loadClosedLoopModel()
  if (!model) return { mlScore: null, modelVersion: null }
  const milestone80 =
    ctx?.milestone80 ??
    payload.principals.some(
      (row) => row.strategyId === 'mcap_enter_at_80' && row.present,
    )
  const entryMcap = finitePositive(ctx?.entryMcap)
  const features = extractClosedLoopFeaturesFromSnapshot({
    parts: payload.parts,
    combinedBase: payload.combined,
    rugTrip: payload.rugTrip,
    adjusters: payload.adjusters,
    entryMcapBand: entryMcap != null ? computeEntryMcapBand(entryMcap) : null,
    milestone80,
  })
  // A near-zero feature dot is sigmoid(bias) for every mint (~0.32 on the
  // live sample). That constant always fails the 0.55 gate. Log null.
  if (isInterceptOnlyClosedLoopScore(features, model)) {
    return { mlScore: null, modelVersion: model.version }
  }
  return {
    mlScore: inferClosedLoopScore(features, model),
    modelVersion: model.version,
  }
}
