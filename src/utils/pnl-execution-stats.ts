/**
 * Execution statistics for one wallet's trading records — one meaning per field.
 *
 * Three different denominators were previously reported as one stat, which is why the daily PnL log
 * printed `successful_trades: 454` next to `total_trades: 372`, and one wallet with `2` trades and `9`
 * successes. Both are impossible if the labels mean what they say:
 *
 *   * a trading record is a BATCH. A single buy of 20 tokens is one record, so counting records is not
 *     counting trades.
 *   * `successCount` counts TOKENS that went through, so it is not comparable to a record count.
 *   * `successCount / (successCount + failureCount)` is an EXECUTION rate — "did the buys I submitted
 *     go through" — not a trading win rate. Named `success_rate` it read as "how often we win", which
 *     is the reading a PnL report invites and which made a losing wallet look perfect.
 *
 * Each field now names its own unit. A genuine win rate comes from closed outcomes
 * (`strategy_outcomes`), which is a different measurement and is not this function's job.
 */
export type ExecutionStats = {
  /** Trading-record rows — BATCHES, not trades. */
  total_records: number
  /** Tokens successfully bought across those records (Σ successCount). */
  tokens_bought: number
  /** Tokens attempted, successful or not (Σ successCount + failureCount). */
  tokens_attempted: number
  /** `tokens_bought / tokens_attempted` as a percentage. An EXECUTION rate, never a win rate. */
  execution_success_rate: number
}

export function executionStatsForRecords(
  records: Array<{ successCount?: number | null; failureCount?: number | null }>,
): ExecutionStats {
  let tokensBought = 0
  let tokensAttempted = 0

  for (const record of records) {
    const ok = Number(record.successCount) || 0
    const failed = Number(record.failureCount) || 0
    tokensBought += ok
    tokensAttempted += ok + failed
  }

  return {
    total_records: records.length,
    tokens_bought: tokensBought,
    tokens_attempted: tokensAttempted,
    execution_success_rate: tokensAttempted > 0 ? (tokensBought / tokensAttempted) * 100 : 0,
  }
}
