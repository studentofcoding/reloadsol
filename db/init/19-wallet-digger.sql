-- Wallet digger + roster concurrence (gmgn_roster_concurrence)

CREATE TABLE IF NOT EXISTS alpha_wallet_roster (
  address TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'active', 'needs_follow', 'demoted', 'banned')),
  follow_status TEXT NOT NULL DEFAULT 'needs_follow'
    CHECK (follow_status IN ('needs_follow', 'followed', 'unfollowed')),
  score DOUBLE PRECISION NOT NULL DEFAULT 0,
  runner_hits INT NOT NULL DEFAULT 0,
  portfolio JSONB,
  notes TEXT,
  promoted_at TIMESTAMPTZ,
  demoted_at TIMESTAMPTZ,
  banned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alpha_wallet_roster_status
  ON alpha_wallet_roster (status);

CREATE INDEX IF NOT EXISTS idx_alpha_wallet_roster_follow
  ON alpha_wallet_roster (follow_status)
  WHERE status IN ('active', 'needs_follow');

CREATE TABLE IF NOT EXISTS alpha_wallet_dig_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  runner_tokens JSONB NOT NULL DEFAULT '[]'::jsonb,
  traders_seen INT NOT NULL DEFAULT 0,
  promoted INT NOT NULL DEFAULT 0,
  demoted INT NOT NULL DEFAULT 0,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS alpha_wallet_dig_hits (
  id BIGSERIAL PRIMARY KEY,
  dig_run_id BIGINT REFERENCES alpha_wallet_dig_runs (id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  profit_usd DOUBLE PRECISION,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (dig_run_id, wallet_address, token_address)
);

CREATE INDEX IF NOT EXISTS idx_alpha_wallet_dig_hits_wallet
  ON alpha_wallet_dig_hits (wallet_address);

CREATE TABLE IF NOT EXISTS alpha_roster_trade_events (
  id BIGSERIAL PRIMARY KEY,
  maker TEXT NOT NULL,
  token_address TEXT NOT NULL,
  side TEXT NOT NULL DEFAULT 'buy',
  amount_usd DOUBLE PRECISION,
  price_usd DOUBLE PRECISION,
  symbol TEXT,
  trade_at TIMESTAMPTZ NOT NULL,
  tx_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alpha_roster_trade_events_tx
  ON alpha_roster_trade_events (tx_hash)
  WHERE tx_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_alpha_roster_trade_events_window
  ON alpha_roster_trade_events (token_address, trade_at DESC);

CREATE TABLE IF NOT EXISTS alpha_concurrence_signals (
  id BIGSERIAL PRIMARY KEY,
  token_address TEXT NOT NULL,
  symbol TEXT,
  makers TEXT[] NOT NULL,
  window_sec INT NOT NULL,
  first_trade_at TIMESTAMPTZ NOT NULL,
  last_trade_at TIMESTAMPTZ NOT NULL,
  fired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  market_cap_usd DOUBLE PRECISION,
  telegram_sent BOOLEAN NOT NULL DEFAULT FALSE,
  sim_opened BOOLEAN NOT NULL DEFAULT FALSE,
  skip_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_alpha_concurrence_signals_token_fired
  ON alpha_concurrence_signals (token_address, fired_at DESC);

INSERT INTO strategy_definitions (id, domain, name, description, config, is_active, execution_mode)
VALUES
  (
    'gmgn_roster_concurrence',
    'gmgn',
    'GMGN Roster Concurrence',
    'Alert + sim when ≥4 dug roster wallets buy the same fresh mint within 15m',
    '{}',
    false,
    'sim_only'
  )
ON CONFLICT (id) DO NOTHING;
