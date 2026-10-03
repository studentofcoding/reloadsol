/**
 * Close reasons that mark an outcome / sell as BOOKKEEPING, not a trade result.
 *
 * `orphan_reconcile` is for the one-off reconciliation of ledger orphans: cycles whose tokens were
 * swallowed by a sibling strategy's sell (see `scopeRecordsToStrategy`) or whose mirror was retired
 * DB-only. Closing them in the ledger frees the `maxOpenPositions` slot they hold, but the price
 * written on such a sell is administrative (mirror last price or breakeven), so it must never reach
 * a win-rate, PnL, leaderboard or lifecycle number.
 *
 * Where the value lives (verified, no migration needed):
 *   - `strategy_outcomes.features->>'close_reason'`           JSONB, unconstrained
 *   - `trading_records.data->'trading_simulation'->>'close_reason'`  JSONB, unconstrained
 *   - `sl_tp_positions.close_reason` IS constrained (db/init/58-sl-tp-close-reason.sql) and does not
 *     list `orphan_reconcile`; a reconciled MIRROR row should use the existing `reconciled` value.
 *     Writers coerce unknown values to `unknown` (closeReasonOrUnknown), so that CHECK can never
 *     reject a close.
 *
 * Nothing writes this value yet. Consumers that aggregate `strategy_outcomes` should AND in
 * `OUTCOME_COUNTS_AS_TRADE_SQL` (or call `isTradeOutcome` on a row in memory).
 */
export const ORPHAN_RECONCILE_CLOSE_REASON = 'orphan_reconcile' as const

/** Every close_reason that is excluded from performance / stats reads. */
export const NON_TRADE_CLOSE_REASONS: readonly string[] = [ORPHAN_RECONCILE_CLOSE_REASON]

/**
 * SQL predicate for `strategy_outcomes` (unqualified `features`; prefix the column for an aliased
 * table: `o.features`). True for every real trade, false for a bookkeeping row. NULL-safe: an
 * outcome with no close_reason is a trade.
 */
export function outcomeCountsAsTradeSql(featuresColumn = 'features'): string {
  const list = NON_TRADE_CLOSE_REASONS.map((r) => `'${r.replace(/'/g, "''")}'`).join(', ')
  return `COALESCE(${featuresColumn}->>'close_reason', '') NOT IN (${list})`
}

/** In-memory twin of `outcomeCountsAsTradeSql`. */
export function isTradeOutcome(
  features: Record<string, unknown> | null | undefined,
): boolean {
  const reason = features?.close_reason
  return !(typeof reason === 'string' && NON_TRADE_CLOSE_REASONS.includes(reason))
}
