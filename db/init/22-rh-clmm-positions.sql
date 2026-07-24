-- Robinhood Uniswap v3/v4 CLMM positions (cost-basis marks; on-chain is source of truth)

CREATE TABLE IF NOT EXISTS rh_clmm_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('v3', 'v4')),
  pool_address TEXT NOT NULL,
  pair_label TEXT,
  token_address TEXT,
  deposit_symbol TEXT,
  owner_address TEXT NOT NULL,
  entry_value_usd NUMERIC NOT NULL DEFAULT 0,
  current_value_usd NUMERIC NOT NULL DEFAULT 0,
  pnl_pct NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'pending')),
  mint_tx TEXT,
  close_tx TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rh_clmm_positions_token
  ON rh_clmm_positions (owner_address, protocol, token_id);
CREATE INDEX IF NOT EXISTS idx_rh_clmm_positions_status ON rh_clmm_positions(status);
CREATE INDEX IF NOT EXISTS idx_rh_clmm_positions_owner ON rh_clmm_positions(owner_address);
