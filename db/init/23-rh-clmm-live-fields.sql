-- Live snapshot fields for RH CLMM positions (Redis is hot; DB is cold fallback)
ALTER TABLE rh_clmm_positions
  ADD COLUMN IF NOT EXISTS unclaimed_fees_usd NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS in_range BOOLEAN,
  ADD COLUMN IF NOT EXISTS tick_lower INTEGER,
  ADD COLUMN IF NOT EXISTS tick_upper INTEGER,
  ADD COLUMN IF NOT EXISTS symbol0 TEXT,
  ADD COLUMN IF NOT EXISTS symbol1 TEXT,
  ADD COLUMN IF NOT EXISTS liquidity TEXT,
  ADD COLUMN IF NOT EXISTS live_synced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_rh_clmm_positions_live_synced
  ON rh_clmm_positions (owner_address, live_synced_at DESC)
  WHERE status = 'open';
