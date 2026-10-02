-- Correct the meaning of the four candle arrays added in 55.
--
-- WHAT WENT WRONG IN 55
-- 55 assumed the vendor's candle endpoint returned token *prices*. It does not: the path is
-- `/api/v1/token_mcap_candles`, and it returns **market-cap** candles. Verified live 2026-10-01:
-- `{"open":"43312343.2355","close":"43409802.0401","high":"44212208.1764","low":"42672754.4333",
--   "volume":"3413.017350511"}` for a token whose market cap is ~$43M.
--
-- Worse, the *other* writer of these columns — the 24h chart cache (`cache_copy`) — holds token
-- **prices** from the chart path (`~1e-3` to `1e-5`). So the same column was holding two different
-- quantities depending on which lane wrote the row: measured, `{gmgn_web}` rows had a median open of
-- 586,287 while `{cache_copy}` rows had a median of 0.00143. Any reader computing a ratio across
-- such rows gets a ~10^9x "gain" that is pure unit mixing, not a ramp.
--
-- THE CONTRACT, NOW
--   * `o_min` / `h_min` / `l_min` / `c_min` are **market-cap candle values (USD)**, from GMGN's
--     `token_mcap_candles`. They are NOT token prices and must not be joined against a price column.
--   * Only a source that reports market-cap candles may write them. The chart cache must not
--     (it contributes volume only, which is scale-free and was already consistent).
--   * `vol_min` is unaffected by all of this: it is USD volume, consistent across every lane.
--   * Invariants from 54/55 still hold unchanged: slot i = minute (i-1); NULL = NOT OBSERVED, never
--     0; no non-finite values; first-writer-wins per field.
--
-- Rows written before this migration that mixed lanes are left in place — the writer never
-- overwrites a slot, and they self-clear under the 30-day prune. No data is deleted here.

COMMENT ON COLUMN token_metrics_history.o_min IS
  'minute open MARKET CAP (USD, GMGN token_mcap_candles); slot i = minute (i-1); NULL = NOT OBSERVED (never 0); never a token price';
COMMENT ON COLUMN token_metrics_history.h_min IS
  'minute high MARKET CAP (USD, GMGN token_mcap_candles); slot i = minute (i-1); NULL = NOT OBSERVED (never 0); never a token price';
COMMENT ON COLUMN token_metrics_history.l_min IS
  'minute low MARKET CAP (USD, GMGN token_mcap_candles); slot i = minute (i-1); NULL = NOT OBSERVED (never 0); never a token price';
COMMENT ON COLUMN token_metrics_history.c_min IS
  'minute close MARKET CAP (USD, GMGN token_mcap_candles); slot i = minute (i-1); NULL = NOT OBSERVED (never 0); never a token price';
COMMENT ON COLUMN token_metrics_history.vol_min IS
  'minute USD volume, scale-free and consistent across sources; slot i = minute (i-1); NULL = NOT OBSERVED (never 0)';
