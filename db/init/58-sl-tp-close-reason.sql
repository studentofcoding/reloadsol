-- The close reason, as a column (SPEC-strategy-exit-standard S2/S5, register C2/C3).
--
-- Why this is a column and not the JSONB that already carries it:
--
--   * `features.close_reason` (strategy_outcomes) and `trading_simulation.close_reason`
--     (trading_records) already record WHY, but neither sits on the position row, so nothing can
--     count closes by reason or watch the backstop share.
--
--   * The mirror row is worse than merely silent. `markSimulatedPositionClosed` writes
--     `tp1_executed = true` for EVERY non-stop trigger, so a `max_age` / `max_hold` backstop lands
--     in the take-profit bucket. The backstop share S5 wants to measure (~0, not 9%) is therefore
--     uncomputable, and the TP count is inflated by exactly the closes that are not take-profits.
--
-- Additive and nullable, the same shape as 57-sl-tp-exit-contract.sql: every existing row reads
-- exactly as it does today, and the live stop path is unaffected until a close stamps a value.

ALTER TABLE sl_tp_positions
  ADD COLUMN IF NOT EXISTS close_reason TEXT,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

ALTER TABLE cron_worker_runtime
  ADD COLUMN IF NOT EXISTS last_skipped_at TIMESTAMPTZ;

-- A closed set (S2) — but with an explicit `unknown` escape hatch, and that detail is the point.
-- A CHECK that can reject a value a writer actually produces would fail a CLOSE, leaving a position
-- open past its stop because of a diagnostic column. That trade is not worth it. So the writers
-- coerce anything unrecognised to 'unknown' (see closeReasonOrUnknown), which means the constraint
-- can never reject a close while an unexpected value is still visible instead of silently absent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sl_tp_positions_close_reason_check'
  ) THEN
    ALTER TABLE sl_tp_positions
      ADD CONSTRAINT sl_tp_positions_close_reason_check
      CHECK (close_reason IS NULL OR close_reason IN (
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
        'unknown'
      ));
  END IF;
END $$;

COMMENT ON COLUMN sl_tp_positions.close_reason IS
  'Why the position closed (S2/S5). NULL on rows that closed before this column existed. Deliberately NOT derived from the sl_executed/tp1_executed flags: those collapse every non-stop trigger into tp1_executed, which files a max_age backstop under take-profit.';

COMMENT ON COLUMN sl_tp_positions.closed_at IS
  'When it closed. updated_at was the only proxy before this, and it moves on any write, so it was never a close time.';

COMMENT ON COLUMN cron_worker_runtime.last_skipped_at IS
  'Last tick skipped because the job lock was held. A skip is the worker working, not failing - but it went unrecorded before this, so "how often did the sole closer not run" had no answer.';
