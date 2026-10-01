import { describe, expect, it } from 'vitest'
import { evaluateExit } from './exit-evaluator'

/** A price-basis position entered at 1, stop -30, target +200. */
function priceExit(over: Record<string, unknown> = {}) {
  return evaluateExit({
    referenceValue: 1,
    referenceKind: 'price',
    live: 1,
    stopLossPct: -30,
    takeProfitPct: 200,
    ...over,
  })
}

describe('evaluateExit — the decision', () => {
  it('fires the stop loss when the live value falls to the threshold', () => {
    const decision = priceExit({ live: 0.7 })
    expect(decision).toMatchObject({
      close: true,
      reason: 'stop_loss',
      triggerType: 'stop_loss',
    })
    expect(decision.pnlPct).toBeCloseTo(-30, 6)
  })

  it('does not fire a stop sitting above the entry (the sign trap)', () => {
    // A stored +30 would put the stop above entry and trip on the first tick.
    const decision = priceExit({ live: 1.001 })
    expect(decision.close).toBe(false)
  })

  it('fires a SINGLE take profit — the case that never fired', () => {
    // `take_profit_percentage` was read only by the `manual` branch, and the sims registered `bot`
    // with no ladder, so this target was never evaluated: Finished: 211 (SL: 211, TP1: 0, ...).
    expect(priceExit({ live: 3.1 })).toMatchObject({
      close: true,
      reason: 'take_profit',
      triggerType: 'take_profit_1',
      sellPercentage: 100,
    })
  })

  it('fires TP1 as a partial when a ladder is configured', () => {
    const decision = priceExit({
      live: 1.5,
      ladder: { tp1Pct: 50, tp1SellPct: 80 },
    })
    expect(decision).toMatchObject({ triggerType: 'take_profit_1', sellPercentage: 80 })
  })

  it('requires TP1 to have executed before TP2', () => {
    const base = { live: 2, ladder: { tp1Pct: 50, tp2Pct: 100 } }
    expect(priceExit({ ...base, ladder: { tp1Pct: 50, tp2Pct: 100, tp1Executed: false } }).triggerType)
      .toBe('take_profit_1')
    expect(
      priceExit({ ...base, ladder: { tp1Pct: 50, tp2Pct: 100, tp1Executed: true } }).triggerType,
    ).toBe('take_profit_2')
  })

  it('does not fire TP3 (a trailing stop) without TP1', () => {
    const decision = priceExit({ live: 1.1, ladder: { tp3Pct: 20, tp3Enabled: true } })
    expect(decision.close).toBe(false)
  })
})

describe('evaluateExit — the basis is data', () => {
  it('reports which basis it used, so a reader never has to infer it', () => {
    expect(evaluateExit({ referenceValue: 1000, referenceKind: 'mcap', live: 2000, takeProfitPct: 50 }))
      .toMatchObject({ close: true, basisUsed: 'mcap' })
    expect(evaluateExit({ referenceValue: 1, referenceKind: 'price', live: 2, takeProfitPct: 50 }))
      .toMatchObject({ basisUsed: 'price' })
  })

  it('treats an absent or unknown basis as price, matching pre-contract rows', () => {
    expect(evaluateExit({ referenceValue: 1, live: 2, takeProfitPct: 50 }).basisUsed).toBe('price')
    expect(evaluateExit({ referenceValue: 1, referenceKind: null, live: 2, takeProfitPct: 50 }).basisUsed).toBe('price')
  })

  it('measures against the stamped reference, not the entry price it replaced', () => {
    // The reference is the price actually PAID (S10). 1.4 against a reference of 1.2 is +16.7%,
    // not the +40% an un-impacted entry of 1.0 would report.
    const decision = evaluateExit({
      referenceValue: 1.2,
      referenceKind: 'price',
      live: 1.4,
      takeProfitPct: 20,
    })
    expect(decision.pnlPct).toBeCloseTo(16.667, 3)
    expect(decision.close).toBe(false)
  })
})

describe('evaluateExit — fail-closed and backstops', () => {
  it('reports stale rather than holding on an unreadable value', () => {
    expect(priceExit({ live: 3, stale: true })).toMatchObject({ close: false, reason: 'stale' })
  })

  it('closes nothing when the live value is missing', () => {
    expect(priceExit({ live: null })).toMatchObject({ close: false, reason: 'hold', pnlPct: null })
    expect(priceExit({ live: 0 })).toMatchObject({ close: false, reason: 'hold' })
  })

  it('closes nothing when the reference itself is missing', () => {
    expect(priceExit({ referenceValue: null })).toMatchObject({ close: false, reason: 'hold' })
  })

  it('fires max_hold as the backstop, after the primary exits', () => {
    const entryAt = new Date(Date.now() - 50 * 3_600_000).toISOString()
    expect(priceExit({ entryAt, maxHoldHours: 48 })).toMatchObject({
      close: true,
      reason: 'max_hold',
    })
    // The primary exit still wins: at the same age, a crossed TP reports take_profit.
    expect(priceExit({ live: 5, entryAt, maxHoldHours: 48 }).reason).toBe('take_profit')
  })
})
