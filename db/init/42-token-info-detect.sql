-- Immutable Token Info detect ledger (Freeview nine tiles).
-- One write-once row per (chain, token_address). History is append-only
-- and is not written by v1 capture. Do not UPDATE the detect row.

CREATE TABLE IF NOT EXISTS token_info_detect (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain TEXT NOT NULL CHECK (chain IN ('sol', 'robinhood')),
  token_address TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL,
  detecting_strategy TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN (
    'mcap_first_seen',
    'mcap_at_80',
    'social',
    'gmgn_pipeline',
    'trending'
  )),
  top10_hold_pct DOUBLE PRECISION,
  dev_hold_pct DOUBLE PRECISION,
  snipers_hold_pct DOUBLE PRECISION,
  sniper_wallet_count DOUBLE PRECISION,
  freeze_auth_active BOOLEAN,
  mint_auth_active BOOLEAN,
  dex_boost_label TEXT,
  pro_traders_pct DOUBLE PRECISION,
  insiders_hold_pct DOUBLE PRECISION,
  bundlers_hold_pct DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain, token_address)
);

CREATE TABLE IF NOT EXISTS token_info_detect_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain TEXT NOT NULL,
  token_address TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  observing_strategy TEXT NOT NULL,
  source TEXT NOT NULL,
  top10_hold_pct DOUBLE PRECISION,
  dev_hold_pct DOUBLE PRECISION,
  snipers_hold_pct DOUBLE PRECISION,
  sniper_wallet_count DOUBLE PRECISION,
  freeze_auth_active BOOLEAN,
  mint_auth_active BOOLEAN,
  dex_boost_label TEXT,
  pro_traders_pct DOUBLE PRECISION,
  insiders_hold_pct DOUBLE PRECISION,
  bundlers_hold_pct DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (chain, token_address)
    REFERENCES token_info_detect (chain, token_address)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_token_info_detect_history_token_observed
  ON token_info_detect_history (chain, token_address, observed_at DESC);

ALTER TABLE token_info_detect ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_info_detect_history ENABLE ROW LEVEL SECURITY;
