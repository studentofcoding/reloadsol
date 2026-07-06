import { getPatternMlMode, getPatternPWinnerMin } from '@/strategies/entry-pattern-scorer'
import { buildFullEntryFeatureSnapshot } from '@/strategies/resolve-entry-snapshot'
import { annotateEntryFeatures, getSocialContext } from '@/strategies/social/context'
import { resolveTokenMonitorSnapshot } from '@/strategies/sim-monitor-snapshots'
import {
  buildMcapOutcomeFeatures,
  fetchMcapTrackingRow,
  isInTrackingRange,
  type McapSnapshot,
} from '@/utils/mcap-tracker'

export type PredictivePatternScore = {
  isPredictive: boolean
  pWinner: number | null
  predicted: 'winner' | 'loser' | null
  modelVersion: string | null
  reason: string | null
}

type PatternScorerModule = typeof import('@/strategies/entry-pattern-scorer.server')
let patternScorerPromise: Promise<PatternScorerModule> | null = null

function getPatternScorer(): Promise<PatternScorerModule> {
  if (!patternScorerPromise) {
    patternScorerPromise = import('@/strategies/entry-pattern-scorer.server')
  }
  return patternScorerPromise
}

export function getPredictiveRecencyMs(): number {
  const raw =
    process.env.MCAP_PREDICTIVE_RECENCY_MINUTES ??
    process.env.NEXT_PUBLIC_MCAP_PREDICTIVE_RECENCY_MINUTES
  const minutes = raw != null && raw !== '' ? Number(raw) : 60
  if (!Number.isFinite(minutes) || minutes <= 0) return 60 * 60 * 1000
  return minutes * 60 * 1000
}

export function isWithinPredictiveRecency(firstSeenAt: string | null | undefined): boolean {
  if (!firstSeenAt) return false
  const ms = new Date(firstSeenAt).getTime()
  if (!Number.isFinite(ms)) return false
  return Date.now() - ms <= getPredictiveRecencyMs()
}

function emptyScore(reason: string): PredictivePatternScore {
  return {
    isPredictive: false,
    pWinner: null,
    predicted: null,
    modelVersion: null,
    reason,
  }
}

export async function scorePredictivePattern(
  tokenAddress: string,
  snapshot?: McapSnapshot | null,
): Promise<PredictivePatternScore> {
  if (getPatternMlMode() === 'off') {
    return emptyScore('pattern_ml_off')
  }

  const row = snapshot ?? (await fetchMcapTrackingRow(tokenAddress))
  if (!row) return emptyScore('no_tracking_row')
  if (row.label === 'rugged') return emptyScore('rugged')
  if (!isWithinPredictiveRecency(row.first_seen_at)) {
    return emptyScore('outside_recency_window')
  }

  const entryMcap = row.first_mcap
  if (!entryMcap || entryMcap <= 0 || !isInTrackingRange(entryMcap)) {
    return emptyScore('out_of_mcap_range')
  }

  const socialCtx = await getSocialContext(tokenAddress)
  const liveMetrics = await resolveTokenMonitorSnapshot(tokenAddress, entryMcap)
  const volume5m = row.volume_5m ?? liveMetrics.volume_5m
  const entryAt = row.first_seen_at

  const baseFeatures = await buildFullEntryFeatureSnapshot(
    tokenAddress,
    {
      entryAt,
      firstSeenAt: row.first_seen_at,
      entryMcap,
      organicScore: row.organic_score,
      topHoldersPct: row.top_holders_pct,
      volume5m,
      tokenSymbol: row.token_symbol,
      monitorSnapshots:
        volume5m != null || liveMetrics.price_usd != null ? [liveMetrics] : [],
      social: socialCtx.snapshot,
      skipJupiter: row.organic_score != null && row.top_holders_pct != null,
    },
    {
      entry_template: 'first_seen',
      ...buildMcapOutcomeFeatures({
        snapshot: row,
        entryTemplate: 'first_seen',
        entryMcap,
        exitMcap: row.current_mcap,
      }),
    },
  )

  const annotated = annotateEntryFeatures(baseFeatures, socialCtx)
  const shadow = await (await getPatternScorer()).scorePatternFeaturesShadow(annotated)
  const pWinner = shadow?.pattern?.pWinner ?? null
  const predicted = shadow?.pattern?.predicted ?? null
  const threshold = getPatternPWinnerMin()

  if (pWinner == null || !Number.isFinite(pWinner)) {
    return {
      isPredictive: false,
      pWinner: null,
      predicted,
      modelVersion: shadow?.modelVersion ?? null,
      reason: 'no_pattern_score',
    }
  }

  const isPredictive = predicted === 'winner' && pWinner >= threshold

  return {
    isPredictive,
    pWinner,
    predicted,
    modelVersion: shadow?.modelVersion ?? null,
    reason: isPredictive ? null : `below_threshold (${pWinner.toFixed(3)} < ${threshold})`,
  }
}
