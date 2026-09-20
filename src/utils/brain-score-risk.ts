/**
 * Phase 3: combined-score overlay for principal sim-opens.
 *
 * After combined is computed, call market-brain GET /risk/from-score and apply
 * returned TP / SL / hold. Climate sizeScale still comes from /regime/params.
 *
 * Flag MARKET_BRAIN_SCORE_RISK defaults on when a read token is set; `0` disables.
 * Brain miss / 4xx → keep the fallback exit (DEFAULT_MCAP_TRACKER_EXIT or
 * recipe / regime knobs already resolved) and stamp riskSource=fallback_default.
 */

import {
  canonicalPrincipalId,
  type CombinedScoreChain,
  type CombinedScoreResponse,
} from '@/strategies/combined-score'
import { loadCombinedScore } from '@/strategies/combined-score-load'
import {
  applyBrainRiskToExit,
  type ExitKnobs,
} from '@/utils/brain-regime-risk'
import {
  fetchBrainRiskFromScore,
  isMarketBrainScoreRiskEnabled,
  type MarketBrainFetchOpts,
} from '@/utils/market-brain'

export const SCORE_OVERLAY_SOURCE = 'score_overlay_v1'
export const FALLBACK_DEFAULT_SOURCE = 'fallback_default'

export type ScoreRiskSource = typeof SCORE_OVERLAY_SOURCE | typeof FALLBACK_DEFAULT_SOURCE

export type ResolvedScoreRisk = {
  called: boolean
  applied: boolean
  riskSource: ScoreRiskSource
  combined: number | null
  autoSl: boolean
  exit: ExitKnobs
  reason?: string
}

export type ResolveScoreRiskParams = MarketBrainFetchOpts & {
  strategyId: string
  mint: string
  chain?: CombinedScoreChain
  hours?: number
  fallbackExit: ExitKnobs
  profileId?: string
  score?: Pick<CombinedScoreResponse, 'combined' | 'rugTrip'>
  loadCombinedScore?: typeof loadCombinedScore
  fetchRisk?: typeof fetchBrainRiskFromScore
}

export function isPrincipalSimOpenStrategy(strategyId: string): boolean {
  return canonicalPrincipalId(strategyId) != null
}

function skipped(fallback: ExitKnobs, reason?: string): ResolvedScoreRisk {
  return {
    called: false,
    applied: false,
    riskSource: FALLBACK_DEFAULT_SOURCE,
    combined: null,
    autoSl: false,
    exit: fallback,
    reason,
  }
}

function fallbackResult(
  fallback: ExitKnobs,
  extras: { combined: number | null; reason?: string },
): ResolvedScoreRisk {
  return {
    called: true,
    applied: false,
    riskSource: FALLBACK_DEFAULT_SOURCE,
    combined: extras.combined,
    autoSl: false,
    exit: fallback,
    reason: extras.reason,
  }
}

export function applyScoreRiskToExit(
  baseExit: ExitKnobs,
  knobs: { takeProfitPct: number; stopLossPct: number; holdHours: number },
): ExitKnobs {
  return applyBrainRiskToExit(baseExit, {
    applied: true,
    source: 'live',
    standDown: false,
    profileId: 'default',
    state: null,
    sizeScale: null,
    takeProfitPct: knobs.takeProfitPct,
    stopLossPct: knobs.stopLossPct,
    holdHours: knobs.holdHours,
  })
}

export function stampScoreRisk(
  features: Record<string, unknown>,
  risk: ResolvedScoreRisk,
): Record<string, unknown> {
  if (!risk.called) return features
  return {
    ...features,
    riskSource: risk.riskSource,
    autoSl: risk.autoSl,
    ...(risk.combined != null ? { combined: risk.combined } : {}),
  }
}

/**
 * Principal sim-open only. Flag off / non-principal → no brain call.
 * Brain 4xx / unreachable / invalid payload → fallback exit + fallback_default.
 */
export async function resolveScoreRiskForSimOpen(
  params: ResolveScoreRiskParams,
): Promise<ResolvedScoreRisk> {
  const fallback = params.fallbackExit
  if (!isPrincipalSimOpenStrategy(params.strategyId)) {
    return skipped(fallback, 'not_principal')
  }
  if (
    !isMarketBrainScoreRiskEnabled({
      baseUrl: params.baseUrl,
      token: params.token,
    })
  ) {
    return skipped(fallback, 'flag_off')
  }

  const fetchOpts: MarketBrainFetchOpts = {
    baseUrl: params.baseUrl,
    token: params.token,
    fetchImpl: params.fetchImpl,
    timeoutMs: params.timeoutMs,
  }

  let combined: number
  let rugTrip = false
  if (params.score) {
    combined = params.score.combined
    rugTrip = params.score.rugTrip === true
  } else {
    try {
      const loadScore = params.loadCombinedScore ?? loadCombinedScore
      const payload = await loadScore({
        address: params.mint,
        chain: params.chain ?? 'sol',
        hours: params.hours ?? 24,
        brain: fetchOpts,
      })
      combined = payload.combined
      rugTrip = payload.rugTrip === true
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return fallbackResult(fallback, { combined: null, reason: msg })
    }
  }

  if (!Number.isFinite(combined)) {
    return fallbackResult(fallback, {
      combined: null,
      reason: 'combined score is not finite',
    })
  }

  const fetchRisk = params.fetchRisk ?? fetchBrainRiskFromScore
  const fetched = await fetchRisk(
    {
      score: combined,
      rugTrip,
      profile: params.profileId,
    },
    fetchOpts,
  )
  if (!fetched.ok) {
    return fallbackResult(fallback, { combined, reason: fetched.error })
  }

  return {
    called: true,
    applied: true,
    riskSource: SCORE_OVERLAY_SOURCE,
    combined,
    autoSl: fetched.data.risk.autoSl,
    exit: applyScoreRiskToExit(fallback, fetched.data.risk),
    reason: fetched.data.risk.source,
  }
}
