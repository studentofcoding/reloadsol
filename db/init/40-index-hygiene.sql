-- Index hygiene: drop indexes that live Postgres proves are unused because their
-- expression does not match the queries that would use them, and add the indexes those
-- queries actually need.
--
-- Evidence: pg_stat_user_indexes.idx_scan = 0 with pg_stat_database.stats_reset = 'never'
-- (so the counters span the database's whole life), plus pg_get_indexdef vs the real SQL.
-- 178 indexes / 807 MB total; 454 MB of unused index space, 438 MB of it one index.
--
-- Measured before (EXPLAIN ANALYZE, prod):
--   trading_records token containment  159 ms — Index Scan, 66,161 rows removed by filter
--   fomo_fills lower(token_address)    187 ms — whole-index scan then filter
--   fomo/ingest occurred_at LIMIT      427 ms — Parallel Seq Scan + top-N sort
--   alpha_wallet_roster status+order     2 ms — already fine, left alone
--
-- Every statement is CONCURRENTLY + IF [NOT] EXISTS: re-runnable, and no write lock on
-- the hot tables. Apply with psql -f (auto-commit) — a CONCURRENTLY statement cannot run
-- inside a transaction, so never wrap this file in BEGIN/COMMIT.

-- A1: this 438 MB GIN is on `(data)`, but the only containment query filters
-- `data->'tokens' @> …` (src/strategies/token-map-activity.ts). Postgres cannot match the
-- indexed expression to the predicate, so the index was never scanned once. Replace it
-- with an index on the expression the query actually uses.
DROP INDEX CONCURRENTLY IF EXISTS idx_trading_records_data_gin;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trading_records_tokens_gin
  ON trading_records USING gin ((data->'tokens') jsonb_path_ops);

-- A2: src/utils/fomo-demand.ts filters on lower(token_address), so the plain-column index
-- could only be scanned end-to-end and then filtered. Index the expression instead, and
-- give fomo/ingest's "ORDER BY occurred_at DESC LIMIT n" (a 427 ms parallel seq scan) an
-- index it never had.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fomo_fills_token_lower_ts
  ON fomo_fills (lower(token_address), occurred_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fomo_fills_occurred
  ON fomo_fills (occurred_at DESC);

-- Superseded by the expression index above / never matched: no query reads fomo_fills by
-- plain token_address or by wallet_address (all four call sites verified in src/).
DROP INDEX CONCURRENTLY IF EXISTS idx_fomo_fills_token_ts;
DROP INDEX CONCURRENTLY IF EXISTS idx_fomo_fills_wallet_ts;

-- A3: the roster's unfiltered "ORDER BY score DESC, updated_at DESC LIMIT n" had no
-- support at all. The status-filtered variant is left alone — it measures 2 ms already.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_alpha_wallet_roster_score
  ON alpha_wallet_roster (score DESC, updated_at DESC);
