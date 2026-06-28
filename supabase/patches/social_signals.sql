-- Social + smart-wallet signal tables

CREATE TABLE IF NOT EXISTS tracked_wallets (
  address TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'tier2' CHECK (tier IN ('tier1', 'tier2')),
  tags TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_polled_at TIMESTAMPTZ,
  last_poll_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tracked_wallets_active
  ON tracked_wallets (is_active, tier);

CREATE TABLE IF NOT EXISTS tracked_wallet_holdings (
  wallet_address TEXT NOT NULL REFERENCES tracked_wallets (address) ON DELETE CASCADE,
  token_address TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (wallet_address, token_address)
);

CREATE INDEX IF NOT EXISTS idx_tracked_wallet_holdings_token
  ON tracked_wallet_holdings (token_address, first_seen_at DESC);

CREATE TABLE IF NOT EXISTS social_token_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('mention', 'wallet_buy', 'wallet_sell')),
  source TEXT NOT NULL,
  channel_id TEXT,
  channel_label TEXT,
  wallet_address TEXT,
  wallet_label TEXT,
  external_message_id TEXT,
  dedupe_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_social_token_events_dedupe
  ON social_token_events (dedupe_key);

CREATE INDEX IF NOT EXISTS idx_social_token_events_token_time
  ON social_token_events (token_address, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_social_token_events_source_time
  ON social_token_events (source, occurred_at DESC);

CREATE TABLE IF NOT EXISTS social_token_rollups (
  token_address TEXT PRIMARY KEY,
  first_seen_at TIMESTAMPTZ,
  first_source TEXT,
  first_channel TEXT,
  mention_count_5m INT NOT NULL DEFAULT 0,
  mention_count_30m INT NOT NULL DEFAULT 0,
  mention_count_24h INT NOT NULL DEFAULT 0,
  unique_channel_count_30m INT NOT NULL DEFAULT 0,
  smart_wallet_buy_count_1h INT NOT NULL DEFAULT 0,
  smart_wallet_buy_sol_1h NUMERIC NOT NULL DEFAULT 0,
  top_source TEXT,
  last_event_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_social_token_rollups_updated
  ON social_token_rollups (updated_at DESC);

ALTER TABLE tracked_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_wallet_holdings ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_token_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_token_rollups ENABLE ROW LEVEL SECURITY;
