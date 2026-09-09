-- reloadSOL Goldsky RH wallet ledger
-- Streamed from Goldsky Turbo pipeline (robinhood_mainnet.erc20_transfers)
-- via webhook -> POST /api/rh/ledger/ingest. Safe to re-run.
--
-- Tables:
--   rh_ledger_transfers  every ERC-20 Transfer touching a tracked RH wallet
--   rh_token_meta        lazily-cached token metadata (decimals/symbol/name/logo)
--   tracked_rh_wallets   operational list of wallets the pipeline follows

-- =============================================================================
-- Ledger
-- =============================================================================

CREATE TABLE IF NOT EXISTS rh_ledger_transfers (
  id              TEXT PRIMARY KEY,          -- <tx_hash>:<log_index>:<in|out>
  wallet_address  TEXT NOT NULL,             -- lowercased 0x wallet this row is for
  direction       TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  token_address   TEXT NOT NULL,             -- lowercased ERC-20 contract
  counterparty    TEXT NOT NULL,             -- other side of the transfer
  amount_raw      NUMERIC(78, 0) NOT NULL,   -- raw base units (decimals applied at read)
  block_number    BIGINT NOT NULL,
  block_timestamp TIMESTAMPTZ NOT NULL,
  tx_hash         TEXT NOT NULL,
  log_index       INT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tx_hash, log_index, wallet_address, direction)
);

CREATE INDEX IF NOT EXISTS idx_rh_ledger_wallet
  ON rh_ledger_transfers (wallet_address, block_number DESC);

CREATE INDEX IF NOT EXISTS idx_rh_ledger_wallet_token
  ON rh_ledger_transfers (wallet_address, token_address);

-- =============================================================================
-- Token metadata cache
-- =============================================================================

CREATE TABLE IF NOT EXISTS rh_token_meta (
  token_address TEXT PRIMARY KEY,
  symbol        TEXT,
  name          TEXT,
  decimals      INT,
  logo_url      TEXT,
  source        TEXT NOT NULL DEFAULT 'blockscout',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Confirmed-dust blacklist: a token lands here only when a real price lookup
-- succeeded AND total holding value was below the display floor, so it can be
-- skipped cheaply on later requests. Re-evaluated after 24h so a re-bought
-- token is not hidden forever.
ALTER TABLE rh_token_meta
  ADD COLUMN IF NOT EXISTS dust_blacklisted BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS blacklisted_at   TIMESTAMPTZ;

-- =============================================================================
-- Tracked wallets (informational; env-seeded at runtime by syncTrackedRhWallets)
-- =============================================================================

CREATE TABLE IF NOT EXISTS tracked_rh_wallets (
  wallet_address TEXT PRIMARY KEY,
  label          TEXT NOT NULL,              -- 'parent' | 'bound' | 'custom'
  added_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
