import { mergeShadowScoresIntoEntryFeatures } from './ml-shadow-log'
import { mergePatternShadowIntoEntryFeatures } from './pattern-shadow-log'

type MlScorerModule = typeof import('./entry-ml-scorer.server')
type PatternScorerModule = typeof import('./entry-pattern-scorer.server')

let mlScorerPromise: Promise<MlScorerModule> | null = null
let patternScorerPromise: Promise<PatternScorerModule> | null = null

function getMlScorer(): Promise<MlScorerModule> {
  if (!mlScorerPromise) mlScorerPromise = import('./entry-ml-scorer.server')
  return mlScorerPromise
}

function getPatternScorer(): Promise<PatternScorerModule> {
  if (!patternScorerPromise) {
    patternScorerPromise = import('./entry-pattern-scorer.server')
  }
  return patternScorerPromise
}

export type AttachMlEntryShadowResult = {
  features: Record<string, unknown>
  gateReject: boolean
  patternReject: boolean
  gateReason: string | null
  patternReason: string | null
  pBad: number | null
  pWinner: number | null
}

/**
 * Attach ML1 gate + ML2 potential + Pattern shadow scores to entry features.
 * By default does not enforce skips — callers that already enforce (mcap) pass enforce=true.
 */
export async function attachMlEntryShadow(
  entryFeatures: Record<string, unknown>,
  opts?: { enforce?: boolean },
): Promise<AttachMlEntryShadowResult> {
  const enforce = opts?.enforce === true
  let features = { ...entryFeatures }

  const shadow = await (await getMlScorer()).scoreEntryFeaturesShadow(features)
  features = mergeShadowScoresIntoEntryFeatures(features, shadow)

  let gateReject = false
  let gateReason: string | null = null
  let pBad: number | null = shadow?.gate?.pBad ?? null
  if (enforce) {
    const gateDecision = await (await getMlScorer()).evaluateMlGateEnforce(shadow)
    gateReject = gateDecision.reject
    gateReason = gateDecision.reason ?? null
    pBad = gateDecision.pBad ?? pBad
  }

  const patternShadow = await (await getPatternScorer()).scorePatternFeaturesShadow(features)
  features = mergePatternShadowIntoEntryFeatures(features, patternShadow)

  let patternReject = false
  let patternReason: string | null = null
  let pWinner: number | null = patternShadow?.pattern?.pWinner ?? null
  if (enforce) {
    const patternDecision = await (
      await getPatternScorer()
    ).evaluatePatternEnforce(patternShadow)
    patternReject = patternDecision.reject
    patternReason = patternDecision.reason ?? null
    pWinner = patternDecision.pWinner ?? pWinner
  }

  if (!shadow && !patternShadow?.pattern) {
    features = {
      ...features,
      ml_skipped: features.ml_skipped ?? 'no_model_or_incomplete_features',
    }
  }

  return {
    features,
    gateReject,
    patternReject,
    gateReason,
    patternReason,
    pBad,
    pWinner,
  }
}
