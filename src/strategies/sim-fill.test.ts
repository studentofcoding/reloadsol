import { describe, expect, it } from 'vitest'
import { fillFromQuote, fillSourceLabel, quoteImpactFraction } from './sim-fill'
import { resolveExecutionParams } from './execution-model'

const PARAMS = resolveExecutionParams({
  SIM_FEE_BPS: '100',
  SIM_SPREAD_BPS: '50',
  SIM_PRIORITY_FEE_QUOTE: '0.002',
  SIM_IMPACT_COEFF: '1',
  SIM_IMPACT_EXPONENT: '1',
})

const depth = { depthQuote: 0, depthSource: 'assumed' as const }

/** The real response shape captured from `api.jup.ag/swap/v2/order` on prod. */
const REAL_ORDER = {
  inAmount: '10000000',
  outAmount: '1191785',
  priceImpactPct: '-0.0001816507849506722',
  priceImpact: '-0.01816507849506722',
}

describe('quoteImpactFraction', () => {
  it('reads priceImpactPct as a fraction', () => {
    expect(quoteImpactFraction(REAL_ORDER)).toBeCloseTo(-0.0001816507849506722, 15)
  })

  it('converts priceImpact, which is a percent, when the fraction is absent', () => {
    expect(quoteImpactFraction({ priceImpact: '-0.01816507849506722' })).toBeCloseTo(
      -0.0001816507849506722,
      15,
    )
  })

  it('returns null rather than 0 for a missing impact', () => {
    expect(quoteImpactFraction({})).toBeNull()
    expect(quoteImpactFraction({ priceImpactPct: null, priceImpact: null })).toBeNull()
  })
})

describe('fillFromQuote — buy', () => {
  it('takes the effective price straight from the quote ratio', () => {
    const fill = fillFromQuote('buy', REAL_ORDER, PARAMS, depth)
    expect(fill).not.toBeNull()
    expect(fill!.effectivePrice).toBeCloseTo(10_000_000 / 1_191_785, 10)
    expect(fill!.tokens).toBe(1_191_785)
    expect(fill!.costQuote).toBeCloseTo(10_000_000 + PARAMS.priorityFeeQuote, 10)
  })

  it('uses the pool’s own reported impact, in bps', () => {
    expect(fillFromQuote('buy', REAL_ORDER, PARAMS, depth)!.impactBps).toBeCloseTo(1.8165, 3)
  })

  it('is not the model: depth is irrelevant to a quoted fill', () => {
    const thin = fillFromQuote('buy', REAL_ORDER, PARAMS, { depthQuote: 1, depthSource: 'liquidity' })!
    const wide = fillFromQuote('buy', REAL_ORDER, PARAMS, { depthQuote: 1e9, depthSource: 'liquidity' })!
    expect(thin.effectivePrice).toBeCloseTo(wide.effectivePrice, 12)
    expect(thin.impactBps).toBeCloseTo(wide.impactBps, 12)
  })
})

describe('fillFromQuote — sell', () => {
  it('treats inAmount as the tokens given and outAmount as quote received', () => {
    const fill = fillFromQuote('sell', { inAmount: '1191785', outAmount: '9950000' }, PARAMS, depth)
    expect(fill!.tokens).toBe(1_191_785)
    expect(fill!.effectivePrice).toBeCloseTo(9_950_000 / 1_191_785, 10)
    expect(fill!.proceedsQuote).toBeCloseTo(9_950_000 - PARAMS.priorityFeeQuote, 10)
    expect(fill!.costQuote).toBe(0)
  })

  it('never returns negative proceeds when the fixed cost exceeds them', () => {
    // A dust exit: the proceeds (0.001) are smaller than the priority fee (0.002).
    const fill = fillFromQuote('sell', { inAmount: '10', outAmount: '0.001' }, PARAMS, depth)
    expect(fill!.proceedsQuote).toBe(0)
    // And a normal exit keeps its proceeds minus the fee.
    const normal = fillFromQuote('sell', { inAmount: '1191785', outAmount: '9950000' }, PARAMS, depth)
    expect(normal!.proceedsQuote).toBeCloseTo(9_950_000 - PARAMS.priorityFeeQuote, 10)
  })
})

describe('unusable quotes fall back rather than fabricate a fill', () => {
  it('rejects missing, empty and zero amounts', () => {
    for (const order of [
      {},
      { inAmount: '100', outAmount: null },
      { inAmount: null, outAmount: '100' },
      { inAmount: '', outAmount: '100' },
      { inAmount: '0', outAmount: '100' },
      { inAmount: '100', outAmount: '0' },
      { inAmount: 'abc', outAmount: '100' },
    ]) {
      expect(fillFromQuote('buy', order, PARAMS, depth)).toBeNull()
    }
  })

  it('still fills when the impact is missing, but reports zero impact', () => {
    const fill = fillFromQuote('buy', { inAmount: '100', outAmount: '50' }, PARAMS, depth)
    expect(fill).not.toBeNull()
    expect(fill!.impactBps).toBe(0)
  })

  it('never produces NaN or Infinity', () => {
    const fill = fillFromQuote('sell', REAL_ORDER, PARAMS, depth)!
    for (const value of [fill.effectivePrice, fill.impactBps, fill.feeQuote, fill.proceedsQuote, fill.tokens]) {
      expect(Number.isFinite(value)).toBe(true)
    }
  })
})

describe('fillSourceLabel', () => {
  it('keeps a quoted fill distinguishable from a modelled one', () => {
    expect(fillSourceLabel('jupiter')).toBe('jupiter-quote')
    expect(fillSourceLabel('model')).toBe('model')
  })
})
