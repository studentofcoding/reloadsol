-- Radar Telegram lifecycle threads (one editable message until dead; new msg on comeback)

CREATE TABLE IF NOT EXISTS radar_alert_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address TEXT NOT NULL,
  token_symbol TEXT,
  chat_id TEXT NOT NULL,
  message_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'dead')),
  kind TEXT NOT NULL DEFAULT 'new'
    CHECK (kind IN ('new', 'comeback')),
  lifecycle INTEGER NOT NULL DEFAULT 1,
  initial_price_usd NUMERIC,
  initial_mcap_usd NUMERIC,
  last_price_usd NUMERIC,
  last_mcap_usd NUMERIC,
  peak_mcap_usd NUMERIC,
  trough_mcap_usd NUMERIC,
  peak_sm NUMERIC NOT NULL DEFAULT 0,
  peak_kol NUMERIC NOT NULL DEFAULT 0,
  death_reason TEXT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_radar_alert_threads_one_open
  ON radar_alert_threads (token_address)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_radar_alert_threads_token
  ON radar_alert_threads (token_address, opened_at DESC);

ALTER TABLE radar_alert_threads ENABLE ROW LEVEL SECURITY;
