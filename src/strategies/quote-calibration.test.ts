import { describe, expect, it } from 'vitest'
import {
  compareModelToQuote,
  normalizeJupiterImpact,
  resolveQuoteSampleEvery,
  summarizeCalibration,
  type CalibrationObservation,
} from './quote-calibration'
import { resolveExecutionParams } from './execution-model'

const MODEL = resolveExecutionParams({
  SIM_FEE_BPS: '100',
  SIM_SPREAD_BPS: '50',
  SIM_IMPACT_COEFF: '1',
  SIM_IMPACT_EXPONENT: '1',
})

function observation(over: Partial<CalibrationObservation> = {}): CalibrationObservation {
  return {
    quoteImpactFraction: -0.001,
    notionalQuote: 1,
    depthQuote: 10,
    depthSource: 'liquidity',
    observedAt: '2026-09-30T00:00:00Z',
    ...over,
  }
}

describe('normalizeJupiterImpact', () => {
  it('prefers priceImpactPct, which is already a fraction', () => {
    // The real pair from prod: the two fields differ by exactly 100x.
    expect(
      normalizeJupiterImpact({ priceImpactPct: -0.0001816507849506722, priceImpact: -0.01816507849506722 }),
    ).toBeCloseTo(-0.0001816507849506722, 12)
  })

  it('converts priceImpact, which is a percent', () => {
    expect(normalizeJupiterImpact({ priceImpact: -0.01816507849506722 })).toBeCloseTo(
      -0.0001816507849506722,
      12,
    )
  })

  it('does not mistake a zero-fraction for a missing value', () => {
    expect(normalizeJupiterImpact({ priceImpactPct: 0, priceImpact: -2 })).toBeCloseTo(-0.02, 12)
    expect(normalizeJupiterImpact({ priceImpactPct: 0 })).toBe(0)
  })

  it('returns null when neither field is usable', () => {
    expect(normalizeJupiterImpact({})).toBeNull()
    expect(normalizeJupiterImpact({ priceImpactPct: 'x', priceImpact: null })).toBeNull()
  })
})

describe('compareModelToQuote', () => {
  it('reports the model-vs-quote delta in bps', () => {
    // Model: 1 * (1/10) = 0.1 fraction; quote says 0.08 => 200bps of over-prediction.
    const got = compareModelToQuote({
      quoteImpactFraction: -0.08,
      notionalQuote: 1,
      depthQuote: 10,
      model: MODEL,
    })
    expect(got?.modelImpactFraction).toBeCloseTo(0.1, 10)
    expect(got?.deltaBps).toBeCloseTo(1800, 6)
  })

  it('has nothing to compare without a size or a depth', () => {
    expect(compareModelToQuote({ quoteImpactFraction: -0.01, notionalQuote: 0, depthQuote: 10, model: MODEL })).toBeNull()
    expect(compareModelToQuote({ quoteImpactFraction: -0.01, notionalQuote: 1, depthQuote: 0, model: MODEL })).toBeNull()
  })
})

describe('summarizeCalibration', () => {
  it('recovers the coefficient that would have matched the quotes', () => {
    // quote impact / (notional/depth) = 0.02 / 0.1 = 0.2 in both rows.
    const summary = summarizeCalibration(
      [
        observation({ quoteImpactFraction: -0.02, notionalQuote: 1, depthQuote: 10 }),
        observation({ quoteImpactFraction: -0.002, notionalQuote: 1, depthQuote: 100 }),
      ],
      MODEL,
    )
    expect(summary.n).toBe(2)
    expect(summary.nWithMeasuredDepth).toBe(2)
    expect(summary.impliedCoeff).toBeCloseTo(0.2, 10)
  })

  it('uses the median, so one outlier cannot move the fit', () => {
    const summary = summarizeCalibration(
      [
        observation({ quoteImpactFraction: -0.02, notionalQuote: 1, depthQuote: 10 }),
        observation({ quoteImpactFraction: -0.02, notionalQuote: 1, depthQuote: 10 }),
        observation({ quoteImpactFraction: -0.9, notionalQuote: 1, depthQuote: 10 }),
      ],
      MODEL,
    )
    expect(summary.impliedCoeff).toBeCloseTo(0.2, 10)
  })

  it('never fits on an assumed depth — that is the model guessing at itself', () => {
    const summary = summarizeCalibration(
      [observation({ depthSource: 'assumed' }), observation({ quoteImpactFraction: -0.02, depthQuote: 10 })],
      MODEL,
    )
    expect(summary.n).toBe(2)
    expect(summary.nAssumedDepth).toBe(1)
    expect(summary.nWithMeasuredDepth).toBe(1)
    expect(summary.impliedCoeff).toBeCloseTo(0.2, 10)
  })

  it('reports counts instead of a fit when there is nothing measured', () => {
    const summary = summarizeCalibration([observation({ depthSource: 'assumed' })], MODEL)
    expect(summary.impliedCoeff).toBeNull()
    expect(summary.medianAbsDeltaBps).toBeNull()
    expect(summary.nAssumedDepth).toBe(1)
  })

  it('handles an empty sample', () => {
    expect(summarizeCalibration([], MODEL)).toEqual({
      n: 0,
      nWithMeasuredDepth: 0,
      nAssumedDepth: 0,
      impliedCoeff: null,
      medianAbsDeltaBps: null,
      medianSpreadBps: null,
    })
  })

  it('ignores degenerate rows rather than producing NaN', () => {
    const summary = summarizeCalibration(
      [observation({ notionalQuote: 0 }), observation({ depthQuote: 0 })],
      MODEL,
    )
    expect(summary.impliedCoeff).toBeNull()
  })
})

describe('resolveQuoteSampleEvery', () => {
  it('is off unless explicitly enabled', () => {
    expect(resolveQuoteSampleEvery({})).toBe(0)
    expect(resolveQuoteSampleEvery({ JUP_QUOTE_SAMPLE_EVERY: '0' })).toBe(0)
    expect(resolveQuoteSampleEvery({ JUP_QUOTE_SAMPLE_EVERY: '-3' })).toBe(0)
    expect(resolveQuoteSampleEvery({ JUP_QUOTE_SAMPLE_EVERY: 'abc' })).toBe(0)
  })

  it('enables 1-in-N sampling', () => {
    expect(resolveQuoteSampleEvery({ JUP_QUOTE_SAMPLE_EVERY: '25' })).toBe(25)
  })
})
