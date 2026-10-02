-- The max-hold backstop, which was accepted and then silently dropped.
--
-- `SimExitThresholds` (src/strategies/sim-exit-contract.ts) has always carried `maxHoldHours`, and
-- every strategy config resolves one (`social/sim-track/route.ts:87`, `spine/route.ts:47`,
-- `potential-exit-overlay.ts`). But `addSLTPPosition` accepted no such parameter and
-- `registerSimExitContract` never passed one, so the value was read, typed, and thrown away.
--
-- Consequence, and it is not theoretical: `checkSLTPTriggers` could not supply `maxHoldHours` to
-- `evaluateExit`, so `max_hold` and `max_age` were UNREACHABLE. A position that never crosses its
-- stop or its target therefore never closed at all — it stayed open indefinitely. That is the
-- mechanism behind the stale open cycles (28 at last count), not a scheduling problem.
--
-- Additive and nullable, the same shape as 57 and 58: existing rows keep NULL and behave exactly as
-- they do today, and the worker treats NULL as "no backstop configured" rather than inventing one.
-- Their value is NOT derivable from the row — the strategy ids encode an `h48` suffix, but parsing a
-- name to decide when to force an exit is exactly the kind of guess this column exists to remove.

ALTER TABLE sl_tp_positions
  ADD COLUMN IF NOT EXISTS max_hold_hours NUMERIC;

COMMENT ON COLUMN sl_tp_positions.max_hold_hours IS
  'Force-close after this many hours (S5). Stamped at open from the strategy''s effective exit. NULL means no backstop is configured, which is a position that can stay open indefinitely — so NULL is a real state, not a default worth guessing at.';

-- The worker reads it alongside the rest of the contract on every pass; the existing `is_active`
-- index predicate already bounds that scan. No new index.
