-- Token metrics history — the durable per-token metric series (the backbone).
--
-- WHY THIS SHAPE
-- Upstream candle volume reaches us (market-brain, Solana Tracker, both GMGN candle endpoints) but
-- is never persisted: our own `token_ohlc_bars` is written by a 15s sampler that only has a Jupiter
-- SPOT price in scope, so `volume` is NULL on 100% of its 875k rows. Meanwhile every other table is
-- latest-only (token_mcap_tracking, token_risk_features), so there is no per-token time series at all.
--
-- Measured before choosing the shape (prod, 2026-10-01):
--   * one row per minute would be 440k rows/day → 4.6–8.7 GB per 30 days against 11 GB free disk
--   * real row cost of a narrow table: 657 B/row all-in (heap 177 MB / indexes 373 MB — indexes dominate)
--   * `float8[60]` = 504 B, `numeric[60]` = 744 B, jsonb array = 968 B, jsonb object = 1,320 B
--   * an all-NULL `float8[60]` costs 32 B, so quiet token-hours are nearly free
--   * shared_buffers = 256 MB while existing indexes already total 817 MB → a 13M-entry index could
--     never stay resident, a ~450k-entry one can
-- So: ONE ROW PER (token, chain, UTC hour) carrying 60 one-minute slots. ~161–335 MB per 30 days at
-- full 1m resolution, and per-token window reads touch 2 rows instead of 100.
--
-- INVARIANTS (the contract — do not violate in any writer or reader)
--   1. vol_min[i] is the traded USD volume for minute (i-1) of that UTC hour, or NULL = NOT OBSERVED.
--   2. NULL is NEVER zero. No read path may COALESCE a missing slot to 0. A slot we did not observe
--      must never read as "no volume" — that is exactly the signal the ramp score keys on.
--   3. Slots are 1-based (Postgres arrays): slot = extract(minute from ts at time zone 'utc') + 1.
--   4. Rows are keyed by UTC hour; DST never applies.
--   5. A 5m bucket has a volume only if ALL FIVE of its minutes were observed — mirroring
--      aggregateTo5m() in src/strategies/rug-signal.ts (which drops v unless every bar has one).
--      A 5m bucket never straddles an hour (60 % 5 == 0), so the rule is per-row.
--   6. No non-finite value ever lands in a slot. Postgres float8 accepts NaN/Infinity and they would
--      poison every downstream sum, so writers filter them.
--   7. fillfactor 70 + the autovacuum override below are REQUIRED: appends change only non-indexed
--      columns, so they are HOT-eligible and never touch the PK index — but only if pages have room.

CREATE TABLE IF NOT EXISTS token_metrics_history (
  token_address   TEXT        NOT NULL,
  chain           TEXT        NOT NULL DEFAULT 'sol',
  hour_bucket     TIMESTAMPTZ NOT NULL,                  -- UTC hour start
  vol_min         float8[60],                            -- slot i = minute (i-1); NULL = not observed
  mcap_close      float8,
  liquidity_close float8,
  price_close     float8,
  holders         INTEGER,
  sources         TEXT[]      NOT NULL DEFAULT '{}',     -- every vendor that contributed a slot
  -- NOTE: coverage is deliberately NOT stored (`slots_filled`): it is derived on read as
  -- `count(x) FROM unnest(vol_min) x` — one source of truth, no drift, and `array_remove(v, NULL)`
  -- does not actually remove NULLs in Postgres.
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (token_address, chain, hour_bucket)
);

-- HOT updates need free space on the page (invariant 7).
ALTER TABLE token_metrics_history SET (fillfactor = 70);

-- The stock autovacuum (scale_factor 0.2 / naptime 60s) is far too lax for a table that takes
-- ~300 updates per minute: it would let ~20% of a growing table rot before vacuuming. 2% keeps it tight.
ALTER TABLE token_metrics_history SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 50,
  autovacuum_analyze_scale_factor = 0.01
);

-- Retention prunes whole hours (never partial arrays) — this index serves that DELETE.
CREATE INDEX IF NOT EXISTS idx_token_metrics_history_hour_bucket
  ON token_metrics_history (hour_bucket DESC);

-- Matches every other table in this repo (see 42-, 48-, 52-*, 54-*).
ALTER TABLE token_metrics_history ENABLE ROW LEVEL SECURITY;
