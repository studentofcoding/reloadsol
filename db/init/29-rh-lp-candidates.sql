-- RH Pools LP decision engine: chain-scope the DLMM candidate/position tables so
-- Robinhood paper LP rows can reuse them, and mirror Trenches trader/closed rows.

ALTER TABLE dlmm_candidates ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'sol';
ALTER TABLE dlmm_candidates ADD COLUMN IF NOT EXISTS confidence NUMERIC;
ALTER TABLE dlmm_candidates ADD COLUMN IF NOT EXISTS features JSONB;
CREATE INDEX IF NOT EXISTS idx_dlmm_candidates_chain_screened
  ON dlmm_candidates (chain, screened_at DESC);

ALTER TABLE dlmm_positions ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'sol';
-- Paper LP bookkeeping (RH): entry mark + symmetric range width so the reasoner
-- can derive in-range / IL without an on-chain position.
ALTER TABLE dlmm_positions ADD COLUMN IF NOT EXISTS entry_price NUMERIC;
ALTER TABLE dlmm_positions ADD COLUMN IF NOT EXISTS range_pct NUMERIC;
CREATE INDEX IF NOT EXISTS idx_dlmm_positions_chain_status
  ON dlmm_positions (chain, status);

-- Trenches (fomo_family) buys, edge-weighted: count + mean wallet edge (1 = neutral).
ALTER TABLE social_token_rollups ADD COLUMN IF NOT EXISTS fomo_buy_count_1h INTEGER NOT NULL DEFAULT 0;
ALTER TABLE social_token_rollups ADD COLUMN IF NOT EXISTS fomo_edge_1h NUMERIC;

-- RobinhoodTrenches leaderboard snapshot (wallet edge scoring).
CREATE TABLE IF NOT EXISTS fomo_traders (
  wallet_address  TEXT PRIMARY KEY,
  handle          TEXT,
  display_name    TEXT,
  followers       BIGINT,
  volume_usd      NUMERIC(28, 12),
  fills           BIGINT,
  buys            BIGINT,
  sells           BIGINT,
  realized_pnl    NUMERIC(28, 12),
  unrealized_pnl  NUMERIC(28, 12),
  net_pnl         NUMERIC(28, 12),
  win_rate        NUMERIC(8, 6),
  closed_trades   BIGINT,
  wins            BIGINT,
  open_bags       BIGINT,
  state           TEXT,
  active          BOOLEAN,
  last_ts         BIGINT,
  raw             JSONB,
  chain           TEXT NOT NULL DEFAULT 'robinhood',
  snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RobinhoodTrenches closed positions (realized outcome labels).
CREATE TABLE IF NOT EXISTS fomo_closed_positions (
  id              BIGSERIAL PRIMARY KEY,
  wallet_address  TEXT NOT NULL,
  token_address   TEXT NOT NULL,
  symbol          TEXT,
  handle          TEXT,
  followers       BIGINT,
  is_stock        BOOLEAN NOT NULL DEFAULT FALSE,
  opened_ts       TIMESTAMPTZ NOT NULL,
  closed_ts       TIMESTAMPTZ NOT NULL,
  cost_sold       NUMERIC(28, 12),
  proceeds_usd    NUMERIC(28, 12),
  pnl_usd         NUMERIC(28, 12),
  pnl_pct         NUMERIC(14, 6),
  hold_seconds    BIGINT,
  buys            INT,
  sells           INT,
  raw             JSONB,
  chain           TEXT NOT NULL DEFAULT 'robinhood',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (wallet_address, token_address, opened_ts, closed_ts)
);

CREATE INDEX IF NOT EXISTS idx_fomo_closed_token_closed
  ON fomo_closed_positions (token_address, closed_ts DESC);
CREATE INDEX IF NOT EXISTS idx_fomo_closed_wallet_closed
  ON fomo_closed_positions (wallet_address, closed_ts DESC);
