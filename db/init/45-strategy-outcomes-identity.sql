-- Enforce the trade identity of strategy_outcomes.
--
-- Identity is (chain, strategy_id, token_address, entry_at). Two defects broke it:
--
-- 1. MIS-KEYED entry_at (fixed in the writers, history repaired by
--    scripts/backfill-strategy-outcome-entry-at-standalone.mjs). The trending-sim
--    writers stamped every later trade of a mint with that mint's FIRST-EVER buy,
--    so 77,319 distinct att_rh trades shared 1,331 entry stamps. The read-side
--    dedupe (dedupeStrategyOutcomeRows) silently collapsed them, so att_rh's PnL
--    and hold times were wrong in every report.
--
-- 2. TRUE DUPLICATES. A position recorded more than once under one identity:
--    - dlmm_default: 820 rows / 24 positions (34.2 per position) because
--      `toCanonicalEntryFeatures` dropped position_id, so the
--      dlmmOutcomeExistsForPosition guard never matched and every
--      /api/dlmm/manage cycle re-inserted the same closed position.
--    - att_rh: 167 rows from phantom closes (an outcome written when the close
--      sell record never landed, then the position closed again for real).
--    - gmgn/signals: ~96 rows of the same shape.
--    Both halves are now enforced at write time: insertStrategyOutcome updates the
--    existing row (update-else-insert) instead of appending.
--
-- Order matters: collapse first, then index. The DELETE is idempotent and only
-- removes rows the read-side dedupe already hides (it keeps the newest
-- exit_at / created_at per identity, the same rule dedupeStrategyOutcomeRows uses),
-- so report output is unchanged by it.
--
-- Apply with psql -f (auto-commit): a CONCURRENTLY statement cannot run inside a
-- transaction, so never wrap this file in BEGIN/COMMIT. Every statement is
-- re-runnable (IF EXISTS / IF NOT EXISTS), matching db/init/40-index-hygiene.sql.

DELETE FROM strategy_outcomes o
 USING strategy_outcomes k
 WHERE o.chain        = k.chain
   AND o.strategy_id  = k.strategy_id
   AND o.token_address = k.token_address
   AND o.entry_at     = k.entry_at
   AND o.token_address IS NOT NULL
   AND o.entry_at     IS NOT NULL
   AND (o.exit_at, o.created_at, o.id) < (k.exit_at, k.created_at, k.id);

-- Partial: rows whose identity is genuinely unknown (token_address or entry_at
-- NULL) must never be forced to collide, and the writer cannot dedupe them anyway.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_strategy_outcomes_identity
  ON strategy_outcomes (chain, strategy_id, token_address, entry_at)
  WHERE token_address IS NOT NULL AND entry_at IS NOT NULL;

-- Superseded: non-unique, same leading columns, only a lookup aid for the old
-- write-side exists-check that has been replaced by the idempotent writer.
DROP INDEX CONCURRENTLY IF EXISTS idx_strategy_outcomes_dedupe;
