import { describe, expect, it } from 'vitest'
import { planContractBackfill } from './backfill-exit-contracts-standalone.mjs'

/** An uncontracted legacy row: the shape `SELECT_SQL` returns. */
function row(over = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    strategy_id: 'search_mcap_first_seen_sl_30_tp150_h48',
    chain: 'sol',
    token_symbol: 'TEST',
    entry_price: 0.0000457,
    stop_loss_percentage: -30,
    take_profit_percentage: 150,
    reference_kind: null,
    reference_value: null,
    exit_basis: null,
    ...over,
  }
}

describe('planContractBackfill', () => {
  it("writes down what the evaluator already assumes: basis price, reference = entry_price", () => {
    // `checkSLTPTriggers` already falls back to `reference_value ?? entry_price`. This does not
    // change how the row is evaluated — it lets the row DECLARE its basis (S3) instead of every
    // caller agreeing on a convention the row cannot state.
    const { updates, stats } = planContractBackfill([row()])

    expect(updates).toHaveLength(1)
    expect(updates[0]).toEqual({
      id: '00000000-0000-0000-0000-000000000001',
      reference_kind: 'price',
      reference_value: 0.0000457,
      exit_basis: 'price',
    })
    expect(stats.derivable).toBe(1)
  })

  it('is idempotent — a row already contracted plans nothing', () => {
    // This is what makes the re-run a no-op, and it is asserted after every apply.
    const contracted = [
      row({ id: 'a', reference_kind: 'price', reference_value: 1, exit_basis: 'price' }),
      row({ id: 'b', reference_kind: 'mcap', reference_value: 2, exit_basis: 'mcap' }),
    ]
    const { updates, stats } = planContractBackfill(contracted)

    expect(updates).toHaveLength(0)
    expect(stats.alreadyContracted).toBe(2)
  })

  it('treats a PARTIAL contract as uncontracted', () => {
    // A row with a basis but no reference value is still uncloseable, so `OR` not `AND` in the
    // selector matters — and the planner must agree with the selector.
    const { updates, stats } = planContractBackfill([
      row({ id: 'a', reference_kind: 'price' }),
      row({ id: 'b', reference_value: 1 }),
      row({ id: 'c', exit_basis: 'price' }),
    ])

    expect(updates).toHaveLength(3)
    expect(stats.alreadyContracted).toBe(0)
  })

  it('leaves an underivable row untouched and reports why, rather than inventing a price', () => {
    const { updates, underivable, stats } = planContractBackfill([
      row({ id: 'a', entry_price: 0 }),
      row({ id: 'b', entry_price: null }),
      row({ id: 'c', entry_price: Number.NaN }),
      row({ id: 'd', entry_price: -1 }),
    ])

    expect(updates).toHaveLength(0)
    expect(underivable).toHaveLength(4)
    expect(underivable.every((u) => u.reason === 'entry_price_not_positive')).toBe(true)
    expect(stats.entryPriceNotPositive).toBe(4)
  })

  it('leaves a row with no usable stop alone too — a reference nothing measures against is not a contract', () => {
    const { updates, underivable } = planContractBackfill([
      row({ id: 'a', stop_loss_percentage: 0 }),
      row({ id: 'b', stop_loss_percentage: null }),
    ])

    expect(updates).toHaveLength(0)
    expect(underivable.every((u) => u.reason === 'stop_loss_percentage_missing')).toBe(true)
  })

  it('never writes a threshold — a wrong derivation must not be able to move a stop', () => {
    const { updates } = planContractBackfill([row()])

    // The only keys are the three contract columns. stop_loss_percentage / take_profit_percentage
    // are already on the row and are deliberately out of scope.
    expect(Object.keys(updates[0]).sort()).toEqual(
      ['exit_basis', 'id', 'reference_kind', 'reference_value'].sort(),
    )
  })

  it('is a pure function of its input — same rows, same plan, no clock and no I/O', () => {
    const rows = [row(), row({ id: 'z', entry_price: 2 })]
    expect(planContractBackfill(rows)).toEqual(planContractBackfill(rows))
  })

  it('accepts a numeric string entry_price, which is what pg returns for NUMERIC', () => {
    // pg hands DECIMAL/NUMERIC back as a string, so `entry_price` is often '0.0000457', not a number.
    const { updates } = planContractBackfill([row({ entry_price: '0.0000457' })])

    expect(updates[0]?.reference_value).toBe(0.0000457)
    expect(typeof updates[0]?.reference_value).toBe('number')
  })
})
