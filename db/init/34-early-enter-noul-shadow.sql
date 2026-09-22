-- Jev Noul soft-gate shadow beside Early Enter (SPEC-jev-soft-gate-shadow-v1).
-- Do NOT overload strategy_ml_predictions (eval-engine sink).

CREATE TABLE IF NOT EXISTS early_enter_noul_shadow (
  id BIGSERIAL PRIMARY KEY,
  predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  token_address TEXT NOT NULL,
  symbol TEXT,
  chain TEXT NOT NULL DEFAULT 'sol',
  strategy_key TEXT NOT NULL,
  cl_ml_score DOUBLE PRECISION,
  cl_model_version TEXT,
  spec_would_pass BOOLEAN NOT NULL,
  noul_called BOOLEAN NOT NULL DEFAULT FALSE,
  noul DOUBLE PRECISION,
  band TEXT NOT NULL
    CHECK (band IN ('suppress', 'mid', 'keep', 'skipped_null', 'api_miss')),
  decision_shadow TEXT NOT NULL
    CHECK (decision_shadow IN ('keep', 'suppress', 'follow_spec')),
  decision_spec TEXT NOT NULL
    CHECK (decision_spec IN ('keep', 'suppress'))
);

CREATE INDEX IF NOT EXISTS early_enter_noul_shadow_predicted_at_idx
  ON early_enter_noul_shadow (predicted_at DESC);

CREATE INDEX IF NOT EXISTS early_enter_noul_shadow_strategy_predicted_idx
  ON early_enter_noul_shadow (strategy_key, predicted_at DESC);

COMMENT ON TABLE early_enter_noul_shadow IS
  'Shadow log for TypeSafe Jev Noul beside Early Enter soft gate. Toast stays SPEC-owned until EARLY_ENTER_NOUL_SOFT_ACTIVE.';
