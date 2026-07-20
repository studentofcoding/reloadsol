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
  rug_label TEXT NOT NULL DEFAULT 'system',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_detect_snapshots_token_detected
  ON token_detect_snapshots (token_address, detected_at DESC);

UPDATE token_detect_snapshots SET rug_label = 'potential' WHERE rug_label = 'not_rug';

ALTER TABLE token_detect_snapshots
  DROP CONSTRAINT IF EXISTS token_detect_snapshots_rug_label_check;

DO $$ BEGIN
  ALTER TABLE token_detect_snapshots
    ADD CONSTRAINT token_detect_snapshots_rug_label_check
    CHECK (rug_label IN ('system', 'rug', 'potential'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE token_detect_snapshots ENABLE ROW LEVEL SECURITY;
