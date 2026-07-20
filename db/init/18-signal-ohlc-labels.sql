-- OHLC snapshots captured when Signals labels Potential / Rugged

CREATE TABLE IF NOT EXISTS signal_ohlc_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address TEXT NOT NULL,
  token_symbol TEXT NULL,
  label TEXT NOT NULL
    CHECK (label IN ('potential', 'rug')),
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  ohlc_interval TEXT NOT NULL DEFAULT '1m'
    CHECK (ohlc_interval IN ('1m', '5m', '15m', '1h')),
  ohlc_source TEXT NOT NULL DEFAULT 'none',
  bars JSONB NOT NULL DEFAULT '[]'::jsonb,
  end_reason TEXT NULL,
  source TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signal_ohlc_labels_label_created
  ON signal_ohlc_labels (label, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_signal_ohlc_labels_token_created
  ON signal_ohlc_labels (token_address, created_at DESC);

ALTER TABLE signal_ohlc_labels ENABLE ROW LEVEL SECURITY;
