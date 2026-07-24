-- Robinhood Uniswap V2 LP positions (operator-global, like dlmm_positions)

CREATE TABLE IF NOT EXISTS rh_univ2_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_address TEXT NOT NULL,
  pair_label TEXT,
  token_address TEXT NOT NULL,
  quote_symbol TEXT NOT NULL CHECK (quote_symbol IN ('USDG', 'WETH')),
  owner_address TEXT NOT NULL,
  lp_token_address TEXT NOT NULL,
  entry_quote_amount NUMERIC NOT NULL DEFAULT 0,
  entry_value_usd NUMERIC NOT NULL DEFAULT 0,
  current_value_usd NUMERIC NOT NULL DEFAULT 0,
  pnl_pct NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'pending')),
  add_tx TEXT,
  remove_tx TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_rh_univ2_positions_status ON rh_univ2_positions(status);
CREATE INDEX IF NOT EXISTS idx_rh_univ2_positions_owner ON rh_univ2_positions(owner_address);
CREATE INDEX IF NOT EXISTS idx_rh_univ2_positions_pool ON rh_univ2_positions(pool_address);
