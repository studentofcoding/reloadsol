-- Pattern cohort 24h: per-chain sol | robinhood (same mint can exist on both).
-- Existing rows default to sol.

ALTER TABLE mcap_social_pattern_24h
  ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'sol';

ALTER TABLE mcap_social_pattern_24h
  DROP CONSTRAINT IF EXISTS mcap_social_pattern_24h_pkey;

ALTER TABLE mcap_social_pattern_24h
  ADD PRIMARY KEY (token_address, chain);

DROP INDEX IF EXISTS idx_mcap_social_pattern_cohort;

CREATE INDEX IF NOT EXISTS idx_mcap_social_pattern_chain_cohort
  ON mcap_social_pattern_24h (chain, cohort, mcap_growth_percent DESC);

CREATE INDEX IF NOT EXISTS idx_mcap_social_pattern_chain_first_seen
  ON mcap_social_pattern_24h (chain, first_seen_at DESC);
