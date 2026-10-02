-- The index the `trading_records` reads were missing.
--
-- Symptom it fixes: `SELECT data FROM trading_records WHERE wallet_address = $1 [AND timestamp >= …]`
-- took **120 seconds** on the 155k-row wallet (`trending-bot-sim-rh` alone holds 155,054 of the
-- table's 164,382 rows / 270 MB), logging 157 `[db-slow-query]` lines and saturating the connection
-- pool — `[db-pool] FAILED … idle=0 waiting=5`, `timeout exceeded when trying to connect` — which in
-- turn pushed the SL/TP pass past its 120s client timeout and cost roughly three quarters of the exit
-- throughput.
--
-- Cause: the only composite index is `(wallet_address, chain, "timestamp" DESC)`, and this query does
-- NOT filter `chain`. A btree can only use the trailing columns when every leading column is
-- constrained, so the `timestamp` predicate was unusable and the planner fell back to
-- `idx_trading_records_wallet`, reading every row for the wallet and filtering afterwards. Bounding
-- the read to 4 days changed nothing for exactly that reason: the filter ran after the scan.
--
-- `(wallet_address, "timestamp" DESC)` matches the predicate the queries actually have, in the
-- direction they actually order by (`ORDER BY timestamp ASC` still reads a DESC index backwards, and
-- both the bounded and the since-last-close forms get it). Additive and idempotent; 164k rows builds
-- in about a second, so the plain (non-CONCURRENTLY) form is safe here and keeps it transaction-safe.
--
-- The `chain`-bearing index is deliberately left in place: it serves the chain-filtered reads. This
-- one is narrower and covers the wallet+time shape, so `idx_trading_records_wallet` becomes redundant
-- — dropped separately, after this is measured, rather than in the same step.

CREATE INDEX IF NOT EXISTS idx_trading_records_wallet_ts
  ON trading_records (wallet_address, "timestamp" DESC);

COMMENT ON INDEX idx_trading_records_wallet_ts IS
  'Serves wallet+time reads, which the (wallet_address, chain, timestamp) index cannot because the queries do not constrain chain.';
