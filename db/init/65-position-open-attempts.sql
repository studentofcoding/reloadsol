-- Durable record of position-open attempt outcomes (SPEC-open-attempts-reporting-v1, map #140).
--
-- Why: the spine's skip decisions live in a 50-entry / 24 h Redis ring (`spine-tick-log.ts`), and a
-- failed open leaves no row anywhere, so "what share of opens fail?" could not be answered. One row per
-- attempt (a retry is its own row). `is_final` marks the verdict of the open, so a retried-then-ok open
-- is one failed-not-final row + the success shown by the position itself.
--
-- Append-only by convention (no trigger: the table is operational telemetry, not evidence).
-- Additive and idempotent: safe to apply before the code lands (AGENTS.md § Deploy chain 7).

CREATE TABLE IF NOT EXISTS position_open_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  strategy_id TEXT NOT NULL,                -- spine worker id when the strategy id is not in scope
  chain TEXT NOT NULL DEFAULT 'sol',
  token_address TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failed', 'skipped')),
  stage TEXT,                               -- gate | price | rug | size | pass | exception | retry
  reason TEXT,
  attempt_no INTEGER NOT NULL DEFAULT 1,
  is_final BOOLEAN NOT NULL DEFAULT TRUE,
  price_usd NUMERIC,
  prev_price_usd NUMERIC,
  price_move_pct NUMERIC,
  detail JSONB
);

CREATE INDEX IF NOT EXISTS idx_position_open_attempts_created ON position_open_attempts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_position_open_attempts_outcome ON position_open_attempts (outcome, created_at DESC);

ALTER TABLE position_open_attempts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE position_open_attempts IS
  'One row per position-open attempt (success / failed / skipped-by-brake with reason). See SPEC-open-attempts-reporting-v1.';
