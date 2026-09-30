import { describe, expect, it } from 'vitest'
import {
  buildExecutionRecord,
  computeBuyFill,
  computeRealizedPnl,
  computeSellFill,
  EXECUTION_MODEL_VERSION,
  resolveDepth,
  resolveExecutionParams,
  type FillInput,
} from './execution-model'

const PARAMS = resolveExecutionParams({
  SIM_FEE_BPS: '100',
  SIM_SPREAD_BPS: '50',
  SIM_PRIORITY_FEE_QUOTE: '0.002',
  SIM_IMPACT_COEFF: '1',
  SIM_IMPACT_EXPONENT: '1',
  SIM_ASSUMED_DEPTH_QUOTE: '30',
})

const depth = { depthQuote: 100, depthSource: 'liquidity' as const }

function buy(over: Partial<FillInput> = {}) {
  return computeBuyFill({ side: 'buy', spotPrice: 1, notionalQuote: 1, depth, params: PARAMS, ...over })
}

function sell(over: Partial<FillInput> = {}) {
  return computeSellFill({
    side: 'sell',
    spotPrice: 1,
    notionalQuote: 0,
    depth,
    params: PARAMS,
    tokenAmount: 1,
    ...over,
  })
}

describe('impact: the constant-product identity', () => {
  it('equals notional/depth with coeff and exponent 1', () => {
    // 1 quote into a 100-quote pool => 100 bps of average price impact, exactly.
    expect(buy().impactBps).toBeCloseTo(100, 6)
    expect(buy({ notionalQuote: 10 }).impactBps).toBeCloseTo(1000, 6)
  })

  it('worsens with size and with a thinner pool', () => {
    const small = buy({ notionalQuote: 0.5 }).impactBps
    const large = buy({ notionalQuote: 5 }).impactBps
    const thin = computeBuyFill({
      side: 'buy',
      spotPrice: 1,
      notionalQuote: 0.5,
      depth: { depthQuote: 10, depthSource: 'liquidity' },
      params: PARAMS,
    }).impactBps
    expect(large).toBeGreaterThan(small)
    expect(thin).toBeGreaterThan(small)
  })

  it('never lets a fill consume more than the pool', () => {
    const huge = buy({ notionalQuote: 100_000 })
    expect(huge.impactBps).toBeLessThanOrEqual(9500)
    expect(huge.effectivePrice).toBeGreaterThan(0)
  })
})

describe('fees and fixed costs are charged on both sides', () => {
  it('takes the fee from the quote side', () => {
    expect(buy({ notionalQuote: 1 }).feeQuote).toBeCloseTo(0.01, 8)
  })

  it('adds the fixed cost to a buy and subtracts it from a sell', () => {
    expect(buy({ notionalQuote: 1 }).costQuote).toBeCloseTo(1.002, 8)
    const s = sell({ spotPrice: 1, tokenAmount: 1 })
    expect(s.fixedCostQuote).toBe(0.002)
    expect(s.proceedsQuote).toBeLessThan(1)
  })
})

describe('realism: the property the old spot-fill model could not express', () => {
  it('a round trip at an unchanged price is a LOSS', () => {
    const entry = buy({ spotPrice: 1, notionalQuote: 1 })
    const exit = sell({ spotPrice: 1, tokenAmount: entry.tokens })
    const pnl = computeRealizedPnl(entry, exit)
    expect(pnl.pnlQuote).toBeLessThan(0)
    // Same price, ~1% fee + 0.5% spread + impact each way: clearly negative, not zero.
    expect(pnl.pnlPct).toBeLessThan(-4)
  })

  it('needs a real move to break even', () => {
    const entry = buy({ spotPrice: 1, notionalQuote: 1 })
    const flat = computeRealizedPnl(entry, sell({ spotPrice: 1, tokenAmount: entry.tokens }))
    const up10 = computeRealizedPnl(entry, sell({ spotPrice: 1.1, tokenAmount: entry.tokens }))
    expect(flat.pnlQuote).toBeLessThan(0)
    expect(up10.pnlQuote).toBeGreaterThan(0)
  })

  it('scales the drag with turnover: two round trips cost more than one', () => {
    const one = computeRealizedPnl(buy(), sell({ tokenAmount: buy().tokens }))
    const two =
      computeRealizedPnl(buy(), sell({ tokenAmount: buy().tokens })).pnlQuote +
      computeRealizedPnl(buy(), sell({ tokenAmount: buy().tokens })).pnlQuote
    expect(two).toBeCloseTo(one.pnlQuote * 2, 8)
  })

  it('reproduces the legacy spot-fill number when everything is zeroed', () => {
    // Proves backwards compatibility: with no costs, the model equals the old exit/entry ratio.
    const free = resolveExecutionParams({
      SIM_FEE_BPS: '0',
      SIM_SPREAD_BPS: '0',
      SIM_PRIORITY_FEE_QUOTE: '0',
      SIM_IMPACT_COEFF: '0',
      SIM_IMPACT_EXPONENT: '1',
    })
    const entry = computeBuyFill({ side: 'buy', spotPrice: 2, notionalQuote: 10, depth, params: free })
    const exit = computeSellFill({
      side: 'sell',
      spotPrice: 3,
      notionalQuote: 0,
      depth,
      params: free,
      tokenAmount: entry.tokens,
    })
    expect(computeRealizedPnl(entry, exit).pnlPct).toBeCloseTo(50, 6)
  })
})

describe('depth resolution and labelling', () => {
  it('prefers measured liquidity', () => {
    expect(resolveDepth({ liquidityQuote: 12.5, volume24hQuote: 900 }, PARAMS)).toEqual({
      depthQuote: 12.5,
      depthSource: 'liquidity',
    })
  })

  it('falls back to a labelled volume proxy', () => {
    expect(resolveDepth({ liquidityQuote: 0, volume24hQuote: 240 }, PARAMS)).toEqual({
      depthQuote: 10,
      depthSource: 'volume_proxy',
    })
  })

  it('falls back to the assumed floor, and says so', () => {
    expect(resolveDepth({}, PARAMS)).toEqual({ depthQuote: 30, depthSource: 'assumed' })
    expect(resolveDepth({ liquidityQuote: -5, volume24hQuote: null }, PARAMS).depthSource).toBe('assumed')
  })

  it('carries the depth source into the fill', () => {
    const assumed = resolveDepth({}, PARAMS)
    expect(buy({ depth: assumed }).depthSource).toBe('assumed')
  })
})

describe('degenerate input never produces NaN or Infinity', () => {
  it('handles missing spot, missing notional, missing tokens and zero depth', () => {
    const cases = [
      buy({ spotPrice: 0 }),
      buy({ notionalQuote: 0 }),
      buy({ depth: { depthQuote: 0, depthSource: 'assumed' } }),
      sell({ spotPrice: 0 }),
      sell({ tokenAmount: 0 }),
      sell({ spotPrice: -1, tokenAmount: 5 }),
    ]
    for (const fill of cases) {
      for (const value of [
        fill.effectivePrice,
        fill.impactBps,
        fill.feeQuote,
        fill.tokens,
        fill.costQuote,
        fill.proceedsQuote,
      ]) {
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('reports zero PnL rather than dividing by a zero cost', () => {
    const empty = computeBuyFill({ side: 'buy', spotPrice: 0, notionalQuote: 0, depth, params: PARAMS })
    expect(computeRealizedPnl(empty, sell()).pnlPct).toBe(0)
  })
})

describe('the stored execution record', () => {
  it('is recomputable: PnL from the record matches PnL from the fills', () => {
    const entry = buy()
    const exit = sell({ tokenAmount: entry.tokens })
    const record = buildExecutionRecord(entry, exit, PARAMS)
    expect(record.model).toBe(EXECUTION_MODEL_VERSION)
    expect(record.entry?.side).toBe('buy')
    expect(record.exit?.side).toBe('sell')
    expect(record.pnlQuote).toBeCloseTo(computeRealizedPnl(entry, exit).pnlQuote, 10)
  })

  it('records an open position without an exit', () => {
    const record = buildExecutionRecord(buy(), null, PARAMS)
    expect(record.exit).toBeNull()
    expect(record).not.toHaveProperty('pnlQuote')
  })

  it('defaults to on, and can be switched off', () => {
    expect(resolveExecutionParams({}).enabled).toBe(true)
    expect(resolveExecutionParams({ SIM_EXECUTION_MODEL: 'off' }).enabled).toBe(false)
  })
})

describe('resolveExecutionParams: the priority fee is what we pay', () => {
  it('defaults to the send fee rather than a round number', () => {
    // The app sends 30,000 lamports per tx and the chain's recent ask is ~0. A larger default is not a
    // conservative choice — it fabricates a cost that dominates every modelled result.
    expect(resolveExecutionParams({}).priorityFeeQuote).toBe(0.00003)
  })
})
