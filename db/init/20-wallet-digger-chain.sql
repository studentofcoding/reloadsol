-- Roster digger/watch: per-chain sol + robinhood

ALTER TABLE alpha_wallet_dig_hits ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'sol';
ALTER TABLE alpha_roster_trade_events ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'sol';
ALTER TABLE alpha_concurrence_signals ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'sol';

ALTER TABLE alpha_wallet_dig_hits
  DROP CONSTRAINT IF EXISTS alpha_wallet_dig_hits_dig_run_id_wallet_address_token_address_key;
DROP INDEX IF EXISTS idx_alpha_roster_trade_events_tx;

CREATE UNIQUE INDEX IF NOT EXISTS idx_alpha_wallet_dig_hits_run_wallet_token_chain
  ON alpha_wallet_dig_hits (dig_run_id, wallet_address, token_address, chain);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alpha_roster_trade_events_tx_chain
  ON alpha_roster_trade_events (tx_hash, chain)
  WHERE tx_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_alpha_roster_trade_events_window_chain
  ON alpha_roster_trade_events (chain, token_address, trade_at DESC);

CREATE INDEX IF NOT EXISTS idx_alpha_concurrence_signals_token_chain_fired
  ON alpha_concurrence_signals (token_address, chain, fired_at DESC);
