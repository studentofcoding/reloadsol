-- Search acceleration for direct DB lookups (token typeahead, token-activity,
-- first-detection, outcomes listing). Idempotent; applied with db/init/*.
-- Enables pg_trgm GIN scans for ILIKE '%term%' and expression btree for
-- lower(address) equality probes.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Q1/Q9: typeahead + mcap admin ILIKE on symbol/address.
CREATE INDEX IF NOT EXISTS idx_mcap_tracking_symbol_trgm
  ON token_mcap_tracking USING gin (lower(coalesce(token_symbol, '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_mcap_tracking_address_trgm
  ON token_mcap_tracking USING gin (lower(token_address) gin_trgm_ops);

-- Q3: first-detection / wallet-digger equality lookups by lower(address).
CREATE INDEX IF NOT EXISTS idx_mcap_tracking_address_lower
  ON token_mcap_tracking (lower(token_address));

-- Q2/Q4: strategy_outcomes by lower(address) — infix (trgm) + equality/prefix
-- path (chain, lower(address), created_at) for per-token activity/history.
CREATE INDEX IF NOT EXISTS idx_strategy_outcomes_address_trgm
  ON strategy_outcomes USING gin (lower(token_address) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_strategy_outcomes_chain_token_created
  ON strategy_outcomes (chain, lower(token_address), created_at DESC NULLS LAST)
  WHERE token_address IS NOT NULL;

-- Q5/Q6: chain-ordered outcomes list + DISTINCT ON (lower(address)) scans.
CREATE INDEX IF NOT EXISTS idx_strategy_outcomes_chain_created
  ON strategy_outcomes (chain, created_at DESC);

-- Q7: token containment in trading_records.jsonb `data` (sim activity poll).
CREATE INDEX IF NOT EXISTS idx_trading_records_data_gin
  ON trading_records USING gin (data);
