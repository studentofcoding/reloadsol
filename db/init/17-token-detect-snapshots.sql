-- OHLC detect snapshots for rug hard-rules + human labels

CREATE TABLE IF NOT EXISTS token_detect_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL
    CHECK (source IN ('concentration', 'freeview')),
  ohlc_interval TEXT NOT NULL DEFAULT '1m'
    CHECK (ohlc_interval IN ('1m', '5m', '15m', '1h')),
  bars JSONB NOT NULL DEFAULT '[]'::jsonb,
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  rule_hits JSONB NOT NULL DEFAULT '[]'::jsonb,
  rug_label TEXT NOT NULL DEFAULT 'system'
    CHECK (rug_label IN ('system', 'rug', 'not_rug')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_detect_snapshots_token_detected
  ON token_detect_snapshots (token_address, detected_at DESC);

ALTER TABLE token_detect_snapshots ENABLE ROW LEVEL SECURITY;
