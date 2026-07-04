-- Rolling 24h mcap + social pattern snapshots (winners / losers cohorts)

CREATE TABLE IF NOT EXISTS mcap_social_pattern_24h (
  token_address TEXT PRIMARY KEY,
  cohort TEXT NOT NULL CHECK (cohort IN ('winner', 'loser')),
  mcap_growth_percent NUMERIC NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  snapshot JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcap_social_pattern_cohort
  ON mcap_social_pattern_24h (cohort, mcap_growth_percent DESC);

CREATE INDEX IF NOT EXISTS idx_mcap_social_pattern_first_seen
  ON mcap_social_pattern_24h (first_seen_at DESC);

ALTER TABLE mcap_social_pattern_24h ENABLE ROW LEVEL SECURITY;
