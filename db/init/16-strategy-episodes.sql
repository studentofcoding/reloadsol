-- Strategy episode archive: shared OHLC + events per mint on last strategy close

CREATE TABLE IF NOT EXISTS strategy_episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  ohlc_interval TEXT NOT NULL DEFAULT '1m'
    CHECK (ohlc_interval IN ('1m', '5m', '15m', '1h')),
  ohlc_source TEXT NOT NULL DEFAULT 'none',
  bars JSONB NOT NULL DEFAULT '[]'::jsonb,
  events JSONB NOT NULL DEFAULT '[]'::jsonb,
  outcome_ids UUID[] NOT NULL DEFAULT '{}',
  rug_label TEXT NULL,
  finalized_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_episodes_token_window_end
  ON strategy_episodes (token_address, window_end);

CREATE INDEX IF NOT EXISTS idx_strategy_episodes_token_finalized
  ON strategy_episodes (token_address, finalized_at DESC);

UPDATE strategy_episodes SET rug_label = 'potential' WHERE rug_label = 'not_rug';

ALTER TABLE strategy_episodes
  DROP CONSTRAINT IF EXISTS strategy_episodes_rug_label_check;

DO $$ BEGIN
  ALTER TABLE strategy_episodes
    ADD CONSTRAINT strategy_episodes_rug_label_check
    CHECK (rug_label IS NULL OR rug_label IN ('rug', 'potential'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE strategy_episodes ENABLE ROW LEVEL SECURITY;
