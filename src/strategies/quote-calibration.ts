/**
 * Calibration: how the execution model's predicted impact compares to a REAL quote.
 *
 * Why this exists instead of quoting every simulated fill. Measured on prod with the account key,
 * the Jupiter order endpoint answers ~8 sequential requests before `429`s and **rejects 100% of
 * concurrent requests** (conc 4/8/12 → 0 OK, rejected in 11–40ms). The sims produce hundreds of
 * fills a day, so quoting each one is not affordable — and worse, it would spend the same quota the
 * *real* trading path needs for its swaps.
 *
 * So real quotes are treated as the scarce ground truth they are: sample them, compare against what
 * the model predicted, and let the measured ratio calibrate the model's coefficient. The model stays
 * the per-fill path (free, always available); the quote is the instrument that keeps it honest.
 *
 * Pure functions only — the caller owns fetching and budgeting.
 */
import type { DepthSource, ExecutionParams } from './execution-model'

/** One observed (real quote, model prediction) pair. */
export interface CalibrationObservation {
  /** The quote's own impact as a FRACTION (e.g. -0.00018), never a percent. */
  quoteImpactFraction: number
  notionalQuote: number
  depthQuote: number
  depthSource: DepthSource
  observedAt: string
}

/**
 * Normalize the two impact fields Jupiter v2 returns. They differ by 100×:
 * `priceImpactPct: -0.00018165` is a fraction and `priceImpact: -0.018165` is a percent, so reading
 * the wrong one is a silent 100× error. `priceImpactPct` wins when both are present.
 */
export function normalizeJupiterImpact(raw: {
  priceImpactPct?: unknown
  priceImpact?: unknown
}): number | null {
  // Presence, not truthiness: `Number(null)` is 0, and a missing field would then read as
  // "0% impact" — a silent claim that a trade was free.
  const hasPct = raw?.priceImpactPct !== undefined && raw?.priceImpactPct !== null
  const pct = hasPct ? Number(raw.priceImpactPct) : Number.NaN
  if (Number.isFinite(pct) && pct !== 0) return pct
  const hasPercent = raw?.priceImpact !== undefined && raw?.priceImpact !== null
  const percent = hasPercent ? Number(raw.priceImpact) : Number.NaN
  if (Number.isFinite(percent)) return percent / 100
  return Number.isFinite(pct) ? pct : null
}

/** What the model predicted for the same trade, and how far off it was. */
export function compareModelToQuote(params: {
  quoteImpactFraction: number
  notionalQuote: number
  depthQuote: number
  model: Pick<ExecutionParams, 'impactCoeff' | 'impactExponent'>
}): { modelImpactFraction: number; deltaFraction: number; deltaBps: number; ratio: number } | null {
  const { notionalQuote, depthQuote, quoteImpactFraction } = params
  if (!(notionalQuote > 0) || !(depthQuote > 0) || !Number.isFinite(quoteImpactFraction)) return null

  const sizeRatio = (notionalQuote / depthQuote) ** params.model.impactExponent
  const modelImpactFraction = params.model.impactCoeff * sizeRatio
  const deltaFraction = modelImpactFraction - quoteImpactFraction
  return {
    modelImpactFraction,
    deltaFraction,
    deltaBps: deltaFraction * 10_000,
    ratio: quoteImpactFraction !== 0 ? modelImpactFraction / quoteImpactFraction : 0,
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Roll observations up into the number that matters: the coefficient that would have matched reality.
 *
 * `impliedCoeff` is the median of `quoteImpact / (notional/depth)` — the value `SIM_IMPACT_COEFF`
 * should take. Medians, not means: one badly-quoted token should not move the calibration, and the
 * sample is reported so a thin calibration cannot be mistaken for a fitted one.
 *
 * Observations whose depth was *assumed* are counted separately and never used for the coefficient:
 * they describe the model's guess, not the market.
 */
export function summarizeCalibration(
  observations: CalibrationObservation[],
  model: Pick<ExecutionParams, 'impactCoeff' | 'impactExponent' | 'spreadBps' | 'feeBps'>,
): {
  n: number
  nWithMeasuredDepth: number
  nAssumedDepth: number
  impliedCoeff: number | null
  medianAbsDeltaBps: number | null
  medianSpreadBps: number | null
} {
  const measured = observations.filter((o) => o.depthSource !== 'assumed')
  const implied: number[] = []
  const deltas: number[] = []
  // A quote's impact covers price movement only; spread and fee are separate knobs, so the
  // residual after removing the fee is the best available spread estimate.
  const spreads: number[] = []

  for (const observation of measured) {
    if (!(observation.notionalQuote > 0) || !(observation.depthQuote > 0)) continue
    const sizeRatio = (observation.notionalQuote / observation.depthQuote) ** model.impactExponent
    if (!(sizeRatio > 0)) continue
    implied.push(-observation.quoteImpactFraction / sizeRatio)
    const comparison = compareModelToQuote({
      quoteImpactFraction: observation.quoteImpactFraction,
      notionalQuote: observation.notionalQuote,
      depthQuote: observation.depthQuote,
      model,
    })
    if (comparison) {
      deltas.push(Math.abs(comparison.deltaBps))
      spreads.push(Math.max(0, -comparison.deltaBps) - model.feeBps)
    }
  }

  return {
    n: observations.length,
    nWithMeasuredDepth: measured.length,
    nAssumedDepth: observations.length - measured.length,
    impliedCoeff: implied.length > 0 ? median(implied) : null,
    medianAbsDeltaBps: deltas.length > 0 ? median(deltas) : null,
    medianSpreadBps: spreads.length > 0 ? median(spreads) : null,
  }
}

/** Is a sampled quote worth the quota? Off by default; a positive integer turns it to 1-in-N. */
export function resolveQuoteSampleEvery(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.JUP_QUOTE_SAMPLE_EVERY)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0
}
