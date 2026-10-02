import { describe, expect, it } from 'vitest'
import { executionStatsForRecords } from './pnl-execution-stats'

/**
 * These pin the units, which is the whole point: the old shape let `successful_trades` exceed
 * `total_trades` in production and print `success_rate: 100` for losing wallets.
 */
describe('executionStatsForRecords', () => {
  it('keeps batches and tokens in SEPARATE fields', () => {
    // One record that bought 20 tokens. Old shape: total_trades=1, successful_trades=20 — which read
    // as "20 out of 1 trades succeeded".
    const stats = executionStatsForRecords([{ successCount: 20, failureCount: 0 }])

    expect(stats.total_records).toBe(1)
    expect(stats.tokens_bought).toBe(20)
    expect(stats.tokens_attempted).toBe(20)
  })

  it('can never report more successes than attempts', () => {
    // The invariant the old shape violated. `tokens_bought` is bounded by `tokens_attempted` by
    // construction, and neither is a record count.
    const stats = executionStatsForRecords([
      { successCount: 3, failureCount: 1 },
      { successCount: 0, failureCount: 5 },
    ])

    expect(stats.tokens_bought).toBe(3)
    expect(stats.tokens_attempted).toBe(9)
    expect(stats.tokens_bought).toBeLessThanOrEqual(stats.tokens_attempted)
  })

  it('is an EXECUTION rate, not a win rate', () => {
    // Every submitted buy went through — and the wallet can still have lost money. The name says so.
    const stats = executionStatsForRecords([{ successCount: 10, failureCount: 0 }])

    expect(stats.execution_success_rate).toBe(100)
  })

  it('handles a partial batch and a total failure', () => {
    expect(
      executionStatsForRecords([{ successCount: 1, failureCount: 3 }]).execution_success_rate,
    ).toBe(25)
    expect(
      executionStatsForRecords([{ successCount: 0, failureCount: 4 }]).execution_success_rate,
    ).toBe(0)
  })

  it('reports 0 rather than NaN when nothing was attempted', () => {
    expect(executionStatsForRecords([]).execution_success_rate).toBe(0)
    expect(executionStatsForRecords([{ successCount: 0, failureCount: 0 }]).execution_success_rate).toBe(0)
  })

  it('treats a missing or malformed count as zero instead of poisoning the sum', () => {
    // pg can hand back null, and one NaN would make every downstream number NaN.
    const stats = executionStatsForRecords([
      { successCount: null, failureCount: undefined },
      { successCount: 5, failureCount: 5 },
    ])

    expect(stats.tokens_bought).toBe(5)
    expect(stats.tokens_attempted).toBe(10)
    expect(Number.isFinite(stats.execution_success_rate)).toBe(true)
  })
})
