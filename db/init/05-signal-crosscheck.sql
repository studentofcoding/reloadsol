-- Telegram signal price cross-check + manual channel config

CREATE TABLE IF NOT EXISTS telegram_signal_channels (
  id TEXT PRIMARY KEY,
  channel_name TEXT NOT NULL,
  channel_id TEXT,
  cluster_name TEXT NOT NULL DEFAULT 'cluster',
  dex_default TEXT,
  tolerance_pct NUMERIC NOT NULL DEFAULT 3,
  sim_buy_sol NUMERIC NOT NULL DEFAULT 0.01,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_signal_channels_channel_id
  ON telegram_signal_channels (channel_id)
  WHERE channel_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS signal_price_crosschecks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address TEXT NOT NULL,
  channel_id TEXT,
  channel_name TEXT NOT NULL,
  token_name TEXT,
  token_symbol TEXT,
  dex TEXT,
  strategy_id TEXT,
  signal_price_usd NUMERIC NOT NULL,
  jupiter_price_usd NUMERIC,
  pct_diff NUMERIC,
  tolerance_pct NUMERIC NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'error')),
  market_cap_usd NUMERIC,
  raw_message TEXT,
  external_message_id TEXT,
  sim_opened BOOLEAN NOT NULL DEFAULT false,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signal_price_crosschecks_occurred
  ON signal_price_crosschecks (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_signal_price_crosschecks_status_occurred
  ON signal_price_crosschecks (status, occurred_at DESC);

ALTER TABLE telegram_signal_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE signal_price_crosschecks ENABLE ROW LEVEL SECURITY;
