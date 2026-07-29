-- Persist v4 PoolKey (fee/tickSpacing/hooks) at mint time so read paths can
-- skip fee/spacing brute-force discovery when ledger data exists.
ALTER TABLE rh_clmm_positions
  ADD COLUMN IF NOT EXISTS pool_id TEXT,
  ADD COLUMN IF NOT EXISTS pool_key JSONB,
  ADD COLUMN IF NOT EXISTS fee INTEGER,
  ADD COLUMN IF NOT EXISTS tick_spacing INTEGER;

CREATE INDEX IF NOT EXISTS idx_rh_clmm_positions_pool_id
  ON rh_clmm_positions (pool_id)
  WHERE status = 'open';
