-- Daily market regime tags for strategy ML context — run on Supabase once.

CREATE TABLE IF NOT EXISTS market_regime_tags (
  tag_date DATE PRIMARY KEY,
  regime_tag TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_market_regime_tags_updated
  ON market_regime_tags (updated_at DESC);
