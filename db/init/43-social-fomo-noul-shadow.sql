-- Shadow log for TypeSafe Jev Noul beside the social FOMO burst paper open.
-- Shadow-only until SOCIAL_FOMO_NOUL_MODE=enforce. Do NOT overload
-- strategy_ml_predictions (eval-engine sink) or early_enter_noul_shadow.

CREATE TABLE IF NOT EXISTS social_fomo_noul_shadow (
  id BIGSERIAL PRIMARY KEY,
  predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  token_address TEXT NOT NULL,
  symbol TEXT,
  chain TEXT NOT NULL DEFAULT 'sol',
  strategy_key TEXT NOT NULL,
  mentions_30m INTEGER NOT NULL,
  mentions_24h INTEGER NOT NULL DEFAULT 0,
  unique_channels_30m INTEGER NOT NULL DEFAULT 0,
  fomo_buy_count_1h INTEGER NOT NULL DEFAULT 0,
  fomo_edge_1h DOUBLE PRECISION,
  mcap DOUBLE PRECISION,
  mcap_growth_pct DOUBLE PRECISION,
  holders_pct DOUBLE PRECISION,
  organic_score DOUBLE PRECISION,
  spec_would_pass BOOLEAN NOT NULL,
  noul_called BOOLEAN NOT NULL DEFAULT FALSE,
  noul DOUBLE PRECISION,
  band TEXT NOT NULL CHECK (band IN ('suppress', 'mid', 'keep', 'api_miss')),
  decision_shadow TEXT NOT NULL CHECK (decision_shadow IN ('keep', 'suppress', 'follow_spec')),
  mode TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow', 'enforce'))
);

CREATE INDEX IF NOT EXISTS social_fomo_noul_shadow_predicted_at_idx
  ON social_fomo_noul_shadow (predicted_at DESC);

CREATE INDEX IF NOT EXISTS social_fomo_noul_shadow_strategy_predicted_idx
  ON social_fomo_noul_shadow (strategy_key, predicted_at DESC);

ALTER TABLE social_fomo_noul_shadow ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE social_fomo_noul_shadow IS
  'Shadow log for TypeSafe Jev Noul beside the social FOMO burst open. Opens stay SPEC-owned (the burst gate) until SOCIAL_FOMO_NOUL_MODE=enforce.';
