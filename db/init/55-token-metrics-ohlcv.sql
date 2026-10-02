-- 1m OHLCV — the price half of the same minute slots.
--
-- 54 stored volume only, because that is what the rug scorer's band needed. The vendor actually
-- hands us **full OHLCV per 1m bar** and `fetchCandles` already parses open/high/low/close — the
-- writer was discarding them. This keeps what was being thrown away, so one row now carries the
-- complete 1m candle instead of the volume alone.
--
-- SAME INVARIANTS AS 54 (they are the contract — do not violate in any writer or reader):
--   * slot i is minute (i-1) of that UTC hour; slots are 1-based.
--   * **NULL is NOT OBSERVED, never 0.** An absent minute is not a flat/zero bar, and no read path
--     may COALESCE a missing slot to 0 — that is exactly the ramp signal the scorer keys on.
--   * These four are **per-minute**. They are NOT the same thing as the hourly `mcap_close` /
--     `liquidity_close` / `price_close` columns, which are end-of-hour snapshots of a different
--     quantity (market cap / pool liquidity) and are never per-minute.
--   * No non-finite value ever lands in a slot (float8 accepts NaN/Infinity, which would poison
--     every downstream comparison), so writers filter them.
--   * First writer to supply a minute wins, per field — a duplicate write is a no-op.
--
-- SHAPE: four parallel `float8[60]` arrays, not one `float8[][]`. Element access and the merge stay
-- one expression per field, and none of the five arrays is indexed, so updates remain HOT-eligible
-- (fillfactor 70 + the autovacuum override from 54 still apply).
--
-- COST (measured, prod 2026-10-01): a filled 60-slot `float8[60]` is 504 B, so these four add
-- ~2 KB/row against ~504 B before. At 300 tokens x 720 hours per 30 days that is ~0.5 GB, against
-- 11 GB free disk. `ADD COLUMN` with a NULL default does not rewrite the table, so this is instant
-- and safe to apply on a live database.

ALTER TABLE token_metrics_history ADD COLUMN IF NOT EXISTS o_min float8[60];
ALTER TABLE token_metrics_history ADD COLUMN IF NOT EXISTS h_min float8[60];
ALTER TABLE token_metrics_history ADD COLUMN IF NOT EXISTS l_min float8[60];
ALTER TABLE token_metrics_history ADD COLUMN IF NOT EXISTS c_min float8[60];

COMMENT ON COLUMN token_metrics_history.o_min IS 'minute open, slot i = minute (i-1); NULL = NOT OBSERVED (never 0)';
COMMENT ON COLUMN token_metrics_history.h_min IS 'minute high, slot i = minute (i-1); NULL = NOT OBSERVED (never 0)';
COMMENT ON COLUMN token_metrics_history.l_min IS 'minute low, slot i = minute (i-1); NULL = NOT OBSERVED (never 0)';
COMMENT ON COLUMN token_metrics_history.c_min IS 'minute close, slot i = minute (i-1); NULL = NOT OBSERVED (never 0)';
