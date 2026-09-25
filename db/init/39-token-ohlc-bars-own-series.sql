-- Adopt token_ohlc_bars as our own 1-minute OHLC series.
--
-- The table existed but was dead (0 rows, no src/ readers or writers, no volume
-- column) after the old OHLC worker was removed — docs/architecture.md called it
-- orphaned and proposed dropping it. The 15s sampler now writes it and
-- loadTokenMapChart reads it as the dependency-free source behind
-- brain -> SolanaTracker -> GMGN.
--
-- Idempotent: safe to re-run. The table's UNIQUE (token_address, interval,
-- timestamp) is what makes the sampler's per-minute upsert idempotent.

ALTER TABLE token_ohlc_bars ADD COLUMN IF NOT EXISTS volume NUMERIC;
ALTER TABLE token_ohlc_bars ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'sampler';
-- How many price samples formed the bar: 1 = a single tick (open=high=low=close),
-- >1 = a real intra-minute high/low.
ALTER TABLE token_ohlc_bars ADD COLUMN IF NOT EXISTS samples INTEGER NOT NULL DEFAULT 1;

-- Retention scans delete by timestamp alone.
CREATE INDEX IF NOT EXISTS idx_token_ohlc_retention ON token_ohlc_bars (timestamp);
