-- RobinhoodTrenches (fomo.family) fill mirror — research-grade, not execution SoT.

CREATE TABLE IF NOT EXISTS fomo_fills (
  id              BIGSERIAL PRIMARY KEY,
  source_fill_id  BIGINT NOT NULL,
  tx              TEXT NOT NULL,
  wallet_address  TEXT NOT NULL,
  token_address   TEXT NOT NULL,
  symbol          TEXT,
  name            TEXT,
  handle          TEXT,
  side            TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  usd             NUMERIC(28, 12),
  amount          NUMERIC(40, 18),
  price           NUMERIC(40, 18),
  mark            NUMERIC(40, 18),
  liquidity       NUMERIC(28, 12),
  followers       BIGINT,
  new_position    BOOLEAN,
  is_stock        BOOLEAN NOT NULL DEFAULT FALSE,
  priced          TEXT,
  block           BIGINT,
  pair_url        TEXT,
  flags           JSONB,
  raw             JSONB,
  occurred_at     TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  chain           TEXT NOT NULL DEFAULT 'robinhood',
  UNIQUE (source_fill_id)
);

CREATE INDEX IF NOT EXISTS idx_fomo_fills_token_ts
  ON fomo_fills (token_address, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_fomo_fills_wallet_ts
  ON fomo_fills (wallet_address, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_fomo_fills_created
  ON fomo_fills (created_at DESC);

CREATE TABLE IF NOT EXISTS fomo_indexer_status (
  id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  lag_seconds     DOUBLE PRECISION,
  last_block      BIGINT,
  last_fill_id    BIGINT,
  last_hello_at   TIMESTAMPTZ,
  last_ingest_at  TIMESTAMPTZ,
  viewers         INT,
  raw_hello       JSONB,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
