import { describe, expect, it } from 'vitest'
import {
  applyClosedLoopExit,
  closedLoopExitMults,
  resolveClosedLoopP,
  sizeFromClosedLoop,
  stampTargetMachineCl,
} from '@/strategies/target-machine-cl-size'

describe('resolveClosedLoopP', () => {
  it('defaults missing to 0.5', () => {
    expect(resolveClosedLoopP(null)).toBe(0.5)
    expect(resolveClosedLoopP(undefined)).toBe(0.5)
    expect(resolveClosedLoopP(Number.NaN)).toBe(0.5)
  })

  it('clamps to [0, 1]', () => {
    expect(resolveClosedLoopP(-1)).toBe(0)
    expect(resolveClosedLoopP(2)).toBe(1)
    expect(resolveClosedLoopP(0.7)).toBe(0.7)
  })
})

describe('closedLoopExitMults', () => {
  it('scales TP up and SL down as p rises', () => {
    const low = closedLoopExitMults(0)
    const high = closedLoopExitMults(1)
    expect(low.tpMult).toBeCloseTo(0.8)
    expect(low.slMult).toBeCloseTo(1.2)
    expect(high.tpMult).toBeCloseTo(1.2)
    expect(high.slMult).toBeCloseTo(0.8)
  })
})

describe('applyClosedLoopExit', () => {
  it('applies mults and floors', () => {
    const r = applyClosedLoopExit({ takeProfitPct: 100, stopLossPct: 20 }, 1)
    expect(r.takeProfitPct).toBeCloseTo(120)
    expect(r.stopLossPct).toBeCloseTo(16)
  })

  it('clamps tiny bases to mins', () => {
    const r = applyClosedLoopExit({ takeProfitPct: 1, stopLossPct: 1 }, 0)
    expect(r.takeProfitPct).toBe(10)
    expect(r.stopLossPct).toBe(5)
  })

  it('keeps negative strategy SL negative (does not floor to +5)', () => {
    const r = applyClosedLoopExit({ takeProfitPct: 100, stopLossPct: -50 }, 1)
    expect(r.stopLossPct).toBeCloseTo(-40)
    expect(r.stopLossPct).toBeLessThan(0)
  })

  it('ceil-magnitudes tiny negative SL to at least -5', () => {
    const r = applyClosedLoopExit({ takeProfitPct: 100, stopLossPct: -1 }, 0)
    expect(r.stopLossPct).toBe(-5)
  })
})

describe('sizeFromClosedLoop', () => {
  it('uses pBad = 1 - p', () => {
    const full = sizeFromClosedLoop(1, 1)
    expect(full.p).toBe(1)
    expect(full.mult).toBe(1)
    expect(full.sol).toBe(1)

    const half = sizeFromClosedLoop(1, 0.5)
    expect(half.mult).toBe(0.5)
    expect(half.sol).toBe(0.5)
  })
})

describe('stampTargetMachineCl', () => {
  it('stamps cl_p and exit fields', () => {
    const stamped = stampTargetMachineCl(
      { a: 1 },
      {
        p: 0.6,
        sized: { sol: 0.6, mult: 0.6 },
        exit: {
          takeProfitPct: 104,
          stopLossPct: 19.2,
          tpMult: 1.04,
          slMult: 0.96,
        },
        modelVersion: 'v1',
      },
    )
    expect(stamped.cl_p).toBe(0.6)
    expect(stamped.ml_size_mult).toBe(0.6)
    expect(stamped.cl_take_profit_pct).toBe(104)
    expect(stamped.cl_model_version).toBe('v1')
  })
})
