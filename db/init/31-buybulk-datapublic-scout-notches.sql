-- buybulk-datapublic-scout paper notes (observe interest, not fills).
-- Isolated from rhtape-datapublic-scout: CHECK forces this strategy id only.
-- Additive / idempotent — safe on existing reloadsol_db volumes.

CREATE TABLE IF NOT EXISTS strategy_paper_notches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id TEXT NOT NULL
    CHECK (strategy_id = 'buybulk-datapublic-scout'),
  chain TEXT NOT NULL
    CHECK (chain IN ('robinhood', 'solana')),
  mint TEXT NOT NULL,
  mint_key TEXT NOT NULL,
  symbol TEXT,
  name TEXT,
  kind TEXT,
  decision TEXT,
  score NUMERIC,
  climate_label TEXT NOT NULL
    CHECK (climate_label = 'Safe'),
  climate_state TEXT,
  climate_at_emit_label TEXT,
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT strategy_paper_notches_dedupe UNIQUE (strategy_id, chain, mint_key)
);

CREATE INDEX IF NOT EXISTS idx_strategy_paper_notches_created
  ON strategy_paper_notches (strategy_id, created_at DESC);

COMMENT ON TABLE strategy_paper_notches IS
  'Paper interest for buybulk-datapublic-scout only. Not a fill; never couple to rhtape-datapublic-scout or trading_records sim buys.';
