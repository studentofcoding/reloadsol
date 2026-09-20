-- Phase 4 shadow eval: persist predictions per scan run and roll accuracy
-- once strategy_outcomes close / labels backfill.

CREATE TABLE IF NOT EXISTS strategy_ml_predictions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mint TEXT NOT NULL,
  token_address TEXT,
  strategy_id TEXT NOT NULL,
  predicted_label TEXT,
  predicted_ml_win BOOLEAN,
  predicted_score DOUBLE PRECISION,
  ml_score DOUBLE PRECISION,
  combined DOUBLE PRECISION,
  model_version TEXT,
  outcome_id TEXT,
  actual_label TEXT,
  actual_ml_win BOOLEAN,
  correct BOOLEAN
);

CREATE INDEX IF NOT EXISTS strategy_ml_predictions_run_idx
  ON strategy_ml_predictions (run_id, predicted_at DESC);

CREATE INDEX IF NOT EXISTS strategy_ml_predictions_mint_strategy_idx
  ON strategy_ml_predictions (mint, strategy_id, predicted_at DESC);

CREATE INDEX IF NOT EXISTS strategy_ml_predictions_outcome_idx
  ON strategy_ml_predictions (outcome_id)
  WHERE outcome_id IS NOT NULL;

ALTER TABLE ml_eval_runs ADD COLUMN IF NOT EXISTS candidate_count INT NOT NULL DEFAULT 0;
ALTER TABLE ml_eval_runs ADD COLUMN IF NOT EXISTS predict_count INT NOT NULL DEFAULT 0;
ALTER TABLE ml_eval_runs ADD COLUMN IF NOT EXISTS linked_count INT NOT NULL DEFAULT 0;
ALTER TABLE ml_eval_runs ADD COLUMN IF NOT EXISTS accuracy DOUBLE PRECISION;
ALTER TABLE ml_eval_runs ADD COLUMN IF NOT EXISTS shadow BOOLEAN NOT NULL DEFAULT TRUE;
