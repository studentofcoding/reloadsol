-- Rolling 24h mcap + social pattern snapshots (winners / losers cohorts)
-- chain dimension: sol | robinhood (same mint can exist on both)

CREATE TABLE IF NOT EXISTS mcap_social_pattern_24h (
  token_address TEXT NOT NULL,
  chain TEXT NOT NULL DEFAULT 'sol',
  cohort TEXT NOT NULL CHECK (cohort IN ('winner', 'loser')),
  mcap_growth_percent NUMERIC NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  snapshot JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (token_address, chain)
);

CREATE INDEX IF NOT EXISTS idx_mcap_social_pattern_chain_cohort
  ON mcap_social_pattern_24h (chain, cohort, mcap_growth_percent DESC);

CREATE INDEX IF NOT EXISTS idx_mcap_social_pattern_first_seen
  ON mcap_social_pattern_24h (first_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_mcap_social_pattern_chain_first_seen
  ON mcap_social_pattern_24h (chain, first_seen_at DESC);

ALTER TABLE mcap_social_pattern_24h ENABLE ROW LEVEL SECURITY;
