-- App network: stamp shared user-data tables with chain (sol | robinhood).
-- Existing rows default to sol.

ALTER TABLE trading_records
  ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'sol';

CREATE INDEX IF NOT EXISTS idx_trading_records_wallet_chain_ts
  ON trading_records (wallet_address, chain, timestamp DESC);

-- Watchlist: unique per wallet+token+chain
ALTER TABLE wallet_watchlist
  ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'sol';

ALTER TABLE wallet_watchlist
  DROP CONSTRAINT IF EXISTS wallet_watchlist_wallet_address_token_address_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wallet_watchlist_wallet_token_chain_key'
  ) THEN
    ALTER TABLE wallet_watchlist
      ADD CONSTRAINT wallet_watchlist_wallet_token_chain_key
      UNIQUE (wallet_address, token_address, chain);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_wallet_watchlist_wallet_chain
  ON wallet_watchlist (wallet_address, chain, added_at DESC);

-- Signals / rug / potential lists
ALTER TABLE trading_signals
  ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'sol';

ALTER TABLE trading_signals DROP CONSTRAINT IF EXISTS trading_signals_token_address_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'trading_signals_token_chain_key'
  ) THEN
    ALTER TABLE trading_signals
      ADD CONSTRAINT trading_signals_token_chain_key
      UNIQUE (token_address, chain);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_trading_signals_chain_label
  ON trading_signals (chain, label);

ALTER TABLE token_rug_list
  ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'sol';

ALTER TABLE token_rug_list DROP CONSTRAINT IF EXISTS token_rug_list_token_address_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'token_rug_list_token_chain_key'
  ) THEN
    ALTER TABLE token_rug_list
      ADD CONSTRAINT token_rug_list_token_chain_key
      UNIQUE (token_address, chain);
  END IF;
END $$;

ALTER TABLE dlmm_potential_list
  ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'sol';

ALTER TABLE dlmm_potential_list DROP CONSTRAINT IF EXISTS dlmm_potential_list_token_address_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dlmm_potential_list_token_chain_key'
  ) THEN
    ALTER TABLE dlmm_potential_list
      ADD CONSTRAINT dlmm_potential_list_token_chain_key
      UNIQUE (token_address, chain);
  END IF;
END $$;
