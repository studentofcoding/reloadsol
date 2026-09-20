-- Phase 4 eval engine: candidate decisions + run summaries.
CREATE TABLE IF NOT EXISTS ml_eval_runs (
  id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  mode TEXT NOT NULL,
  scanned INT NOT NULL DEFAULT 0,
  skipped INT NOT NULL DEFAULT 0,
  paper_opened INT NOT NULL DEFAULT 0,
  live_attempted INT NOT NULL DEFAULT 0,
  errors INT NOT NULL DEFAULT 0,
  summary JSONB
);

CREATE TABLE IF NOT EXISTS ml_eval_decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  mint TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  combined DOUBLE PRECISION,
  ml_score DOUBLE PRECISION,
  model_version TEXT,
  action TEXT NOT NULL,
  reason TEXT,
  mode TEXT NOT NULL,
  risk JSONB,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ml_eval_decisions_mint_strategy_idx
  ON ml_eval_decisions (mint, strategy_id, decided_at DESC);
