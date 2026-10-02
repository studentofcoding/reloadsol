import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PERSISTED_CLOSE_REASONS, evaluateExit, toPersistedCloseReason } from './exit-evaluator'

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

describe('the persisted close reason', () => {
  const fiftyHoursAgo = new Date(Date.now() - 50 * 3_600_000).toISOString()

  it('gives max_age its own trigger, so a backstop is not filed as max_hold', () => {
    // Both backstops used to return 'max_hold_time'. That made them indistinguishable in the row and
    // left `WORKER_CLOSE_REASONS`'s `max_age` entry unreachable, which is exactly why S5's backstop
    // share could not be computed.
    expect(priceExit({ entryAt: fiftyHoursAgo, maxAgeHours: 48 })).toMatchObject({
      close: true,
      reason: 'max_age',
      triggerType: 'max_age',
    })
    expect(priceExit({ entryAt: fiftyHoursAgo, maxHoldHours: 48 }).triggerType).toBe('max_hold_time')
  })

  it('passes through every reason the writers actually produce', () => {
    for (const reason of [
      'stop_loss',
      'take_profit',
      'max_hold',
      'max_age',
      'label_rugged',
      'strategy_deactivated',
      'tracking_stopped',
      'no_balance',
      'reconciled',
      'removed',
    ]) {
      expect(toPersistedCloseReason(reason), reason).toBe(reason)
    }
  })

  it('coerces an unrecognised reason to unknown rather than throwing', () => {
    // This runs on the close path. Throwing here would leave a position open past its stop because a
    // diagnostic label did not match a list — a far worse failure than a missing reason.
    expect(toPersistedCloseReason('nonsense')).toBe('unknown')
    expect(toPersistedCloseReason(undefined)).toBe('unknown')
    expect(toPersistedCloseReason(null)).toBe('unknown')
    expect(toPersistedCloseReason('')).toBe('unknown')
  })

  it('keeps unknown inside the set, so the CHECK can never reject a close', () => {
    expect(PERSISTED_CLOSE_REASONS).toContain('unknown')
    expect(PERSISTED_CLOSE_REASONS).toContain(toPersistedCloseReason('anything at all'))
  })
})

describe('the close vocabulary, the rug close, and an unreadable input', () => {
  it('closes a rugged token before the thresholds are consulted', () => {
    // A rug is not a threshold event — the threshold it would cross is the one that never comes
    // back. Here the price is ABOVE entry and still well inside the stop and target, so nothing but
    // the rug label can be what closes it.
    expect(priceExit({ live: 1.05, rugged: true })).toMatchObject({
      close: true,
      reason: 'label_rugged',
      triggerType: 'label_rugged',
      sellPercentage: 100,
    })
    // And it beats a stop that would otherwise have fired, because it is the truer reason.
    expect(priceExit({ live: 0.5, rugged: true }).reason).toBe('label_rugged')
  })

  it('does not invent a rug close for a normal position', () => {
    expect(priceExit({ live: 1.05, rugged: false }).close).toBe(false)
    expect(priceExit({ live: 1.05 }).close).toBe(false)
  })

  it('reports STALE when the input could not be read, even though that arrives as a zero', () => {
    // This is the ordering that matters. A value that could not be read arrives as a missing/zero
    // `live`, so checking the positive-value guard FIRST reported it as an ordinary `hold` — a hold
    // nobody can see, which is precisely what S4 forbids.
    expect(priceExit({ live: 0, stale: true })).toMatchObject({ close: false, reason: 'stale' })
    expect(priceExit({ live: Number.NaN, stale: true }).reason).toBe('stale')
    // Unchanged when nothing claims staleness: a missing value is still an ordinary hold.
    expect(priceExit({ live: 0 }).reason).toBe('hold')
  })

  it('counts a rugged token that cannot be priced as STALE, not as a rug close', () => {
    // Closing needs a price to close AT. An unpriced rug stays open and is reported, rather than
    // being closed at a number nobody read.
    expect(priceExit({ live: 0, rugged: true, stale: true })).toMatchObject({
      close: false,
      reason: 'stale',
    })
  })

  it('cannot drift from the CHECK in the migration', () => {
    // The column's CHECK enumerates the same set. If a writer emits a value the migration forbids,
    // the CLOSE fails — so the two lists are pinned to each other here, read from the real file
    // rather than from a copy of it.
    const sql = readFileSync(
      fileURLToPath(new URL('../../db/init/58-sl-tp-close-reason.sql', import.meta.url)),
      'utf8',
    )
    const start = sql.indexOf('close_reason IN (')
    const end = sql.indexOf(')', sql.indexOf("'unknown'", start))
    const allowed = [...sql.slice(start, end).matchAll(/'([a-z_]+)'/g)]
      .map((m) => m[1])
      .filter((v): v is string => Boolean(v))

    expect(start).toBeGreaterThan(-1)
    expect(allowed.length).toBeGreaterThan(0)
    for (const reason of PERSISTED_CLOSE_REASONS) {
      expect(allowed, `${reason} must be allowed by the CHECK`).toContain(reason)
    }
    for (const reason of allowed) {
      expect(PERSISTED_CLOSE_REASONS as readonly string[]).toContain(reason)
    }
  })
})
