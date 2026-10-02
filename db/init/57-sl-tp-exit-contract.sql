-- The exit contract on an SL/TP position (S8), and the price actually paid (S10).
--
-- Why the row could not answer either question before:
--
--   * `stop_loss_percentage` / `take_profit_percentage` are bare numbers. Nothing on the row says
--     whether they are measured in USD price or in mcap growth, so every caller has to agree on a
--     convention. The mcap family works around this by registering a price-derived value
--     (see mcap-tracking/sim-track/route.ts) — a correct choice, but an undocumented one the row
--     itself cannot state.
--
--   * `entry_price` is the market quote at entry, not the price the simulated fill actually got.
--     A modelled fill pays `spotPrice * (1 + impact + spread)`, so a stop measured from the quote is
--     measured from a price the trade never paid.
--
-- Both are additive and nullable: existing rows keep reading exactly as they do today, and the live
-- stop path (which uses price/price) is unaffected until an open stamps a value.

ALTER TABLE sl_tp_positions
  ADD COLUMN IF NOT EXISTS reference_kind TEXT,
  ADD COLUMN IF NOT EXISTS reference_value DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS exit_basis TEXT,
  ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'sol';

-- `chain` because the worker hardcoded 'sol' when pricing (`getCurrentTokenPrices` ->
-- `getOpenPositionPrices(..., 'sol')`, on the strength of "sl_tp_positions is Solana live-only").
-- A Robinhood position registered into this table would be priced through the Solana path and
-- evaluated against a number that is not its price. Defaulting to 'sol' preserves every existing
-- row's behaviour exactly.

-- `reference_kind` is what `reference_value` is: a USD price, or an mcap.
-- `exit_basis` is what the thresholds are expressed in. Deliberately separate: the mcap family's TP
-- is mcap-targeted while its SL is price-targeted, so the two can disagree, and pinning them to one
-- column would hide exactly the disagreement the standard exists to expose.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sl_tp_positions_reference_kind_check'
  ) THEN
    ALTER TABLE sl_tp_positions
      ADD CONSTRAINT sl_tp_positions_reference_kind_check
      CHECK (reference_kind IS NULL OR reference_kind IN ('price', 'mcap'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sl_tp_positions_exit_basis_check'
  ) THEN
    ALTER TABLE sl_tp_positions
      ADD CONSTRAINT sl_tp_positions_exit_basis_check
      CHECK (exit_basis IS NULL OR exit_basis IN ('price', 'mcap'));
  END IF;
END $$;

COMMENT ON COLUMN sl_tp_positions.reference_kind IS
  'What reference_value is: ''price'' (USD) or ''mcap''. NULL on pre-contract rows, which read as ''price''.';
COMMENT ON COLUMN sl_tp_positions.reference_value IS
  'The value the thresholds are measured against, stamped at open (S8). Never re-derived from a cache.';
COMMENT ON COLUMN sl_tp_positions.exit_basis IS
  'What stop_loss_percentage / take_profit_percentage are expressed in: ''price'' or ''mcap'' (S3).';

-- The worker reads all open rows every 60s; the contract columns are read alongside them. No new
-- index: the existing `is_active` predicate already bounds the scan to open positions.
