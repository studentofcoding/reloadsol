-- reloadSOL Supabase schema
-- Run once in the Supabase SQL editor. Safe to re-run (IF NOT EXISTS / idempotent patches).
--
-- Tables used by the app:
--   token_operations, trading_records, trading_signals, sl_tp_positions
--   trending_token_tracker (+ _dev), trending_token_summary (+ _dev)
--   token_mcap_tracking, mcap_threshold_notifications, token_ohlc_bars
--   dlmm_agent_config, dlmm_candidates, dlmm_positions, dlmm_lessons

-- =============================================================================
-- Wallet operations & trading records
-- =============================================================================

CREATE TABLE IF NOT EXISTS token_operations (
  wallet_address TEXT PRIMARY KEY,
  swap_count INTEGER NOT NULL DEFAULT 0,
  close_count INTEGER NOT NULL DEFAULT 0,
  sol_balance NUMERIC NOT NULL DEFAULT 0,
  total_sol_recovered NUMERIC NOT NULL DEFAULT 0,
  last_operation_time TIMESTAMPTZ,
  last_balance_update TIMESTAMPTZ,
  last_connected TIMESTAMPTZ,
  estimated_location TEXT,
  telegram_handle TEXT,
  telegram_verified BOOLEAN NOT NULL DEFAULT false,
  telegram_verification_time TIMESTAMPTZ,
  tx_level INTEGER NOT NULL DEFAULT 0,
  ask_for_fund BOOLEAN NOT NULL DEFAULT false,
  amount_ask_for_fund NUMERIC NOT NULL DEFAULT 0,
  last_assistance_request TIMESTAMPTZ,
  trade_pnl NUMERIC NOT NULL DEFAULT 0,
  last_pnl_update TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS trading_records (
  id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trading_records_wallet ON trading_records(wallet_address);
CREATE INDEX IF NOT EXISTS idx_trading_records_timestamp ON trading_records(timestamp DESC);

CREATE TABLE IF NOT EXISTS trading_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address TEXT NOT NULL UNIQUE,
  token_symbol TEXT,
  label TEXT CHECK (label IN ('watching', 'potential', 'rugged')),
  market_cap NUMERIC NOT NULL DEFAULT 0,
  price NUMERIC NOT NULL DEFAULT 0,
  initial_price NUMERIC NOT NULL DEFAULT 0,
  result JSONB,
  image_reference TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  user_wallet TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trading_signals_label ON trading_signals(label);

CREATE TABLE IF NOT EXISTS sl_tp_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  token_symbol TEXT NOT NULL,
  position_size NUMERIC NOT NULL,
  entry_price NUMERIC NOT NULL,
  current_price NUMERIC NOT NULL,
  stop_loss_price NUMERIC NOT NULL,
  take_profit_price NUMERIC NOT NULL,
  stop_loss_percentage NUMERIC NOT NULL,
  take_profit_percentage NUMERIC NOT NULL,
  position_type TEXT NOT NULL CHECK (position_type IN ('manual', 'bot')),
  strategy_id TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  tp1_percentage NUMERIC,
  tp1_sell_percentage NUMERIC,
  tp2_percentage NUMERIC,
  tp3_percentage NUMERIC,
  tp3_enabled BOOLEAN,
  tp1_executed BOOLEAN NOT NULL DEFAULT false,
  tp2_executed BOOLEAN NOT NULL DEFAULT false,
  tp3_executed BOOLEAN NOT NULL DEFAULT false,
  sl_executed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sl_tp_positions_wallet ON sl_tp_positions(wallet_address);
CREATE INDEX IF NOT EXISTS idx_sl_tp_positions_active ON sl_tp_positions(is_active) WHERE is_active = true;

-- Atomic increment for swap/close counts (used by /api/operations/track and /api/operations/sync)
CREATE OR REPLACE FUNCTION increment_operation_counts(
  p_wallet_address TEXT,
  p_swap_increment INTEGER,
  p_close_increment INTEGER,
  p_sol_balance NUMERIC DEFAULT NULL,
  p_timestamp TIMESTAMPTZ DEFAULT NOW()
) RETURNS VOID AS $$
BEGIN
  INSERT INTO token_operations (
    wallet_address,
    swap_count,
    close_count,
    last_operation_time,
    sol_balance,
    last_balance_update
  ) VALUES (
    p_wallet_address,
    p_swap_increment,
    p_close_increment,
    p_timestamp,
    COALESCE(p_sol_balance, 0),
    p_timestamp
  )
  ON CONFLICT (wallet_address)
  DO UPDATE SET
    swap_count = COALESCE(token_operations.swap_count, 0) + p_swap_increment,
    close_count = COALESCE(token_operations.close_count, 0) + p_close_increment,
    last_operation_time = p_timestamp,
    sol_balance = CASE
      WHEN p_sol_balance IS NOT NULL THEN p_sol_balance
      ELSE COALESCE(token_operations.sol_balance, 0)
    END,
    last_balance_update = CASE
      WHEN p_sol_balance IS NOT NULL THEN p_timestamp
      ELSE COALESCE(token_operations.last_balance_update, token_operations.last_operation_time)
    END;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- Trending token tracker
-- =============================================================================

CREATE TABLE IF NOT EXISTS trending_token_tracker (
  id TEXT PRIMARY KEY,
  token_address TEXT NOT NULL UNIQUE,
  token_symbol TEXT,
  token_name TEXT,
  logo_url TEXT,
  initial_price_usd NUMERIC NOT NULL DEFAULT 0,
  last_price_usd NUMERIC NOT NULL DEFAULT 0,
  peak_price_usd NUMERIC NOT NULL DEFAULT 0,
  current_gain_percentage NUMERIC NOT NULL DEFAULT 0,
  peak_gain_percentage NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'tracking', 'won', 'lost', 'skipped', 'stopped')),
  organic_score NUMERIC,
  market_cap NUMERIC,
  volume_1h NUMERIC,
  volume_5m NUMERIC,
  tracking_started_at TIMESTAMPTZ,
  status_changed_at TIMESTAMPTZ,
  waiting_started_at TIMESTAMPTZ,
  waiting_initial_price NUMERIC,
  trading_simulation JSONB,
  price_history JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trending_tracker_token ON trending_token_tracker(token_address);
CREATE INDEX IF NOT EXISTS idx_trending_tracker_status ON trending_token_tracker(status);
CREATE INDEX IF NOT EXISTS idx_trending_tracker_tracking_started ON trending_token_tracker(tracking_started_at);
-- idx_trending_tracker_waiting is created in the patches section (after waiting columns are ensured)

CREATE TABLE IF NOT EXISTS trending_token_summary (
  id TEXT PRIMARY KEY,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  total_tokens_tracked INTEGER NOT NULL DEFAULT 0,
  won_tokens INTEGER NOT NULL DEFAULT 0,
  lost_tokens INTEGER NOT NULL DEFAULT 0,
  still_tracking INTEGER NOT NULL DEFAULT 0,
  win_rate NUMERIC NOT NULL DEFAULT 0,
  top_winners JSONB,
  avg_peak_gain NUMERIC NOT NULL DEFAULT 0,
  max_peak_gain NUMERIC NOT NULL DEFAULT 0,
  avg_loss NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trending_summary_created ON trending_token_summary(created_at DESC);

-- Dev mirrors (NODE_ENV=development uses these to avoid prod collisions)
CREATE TABLE IF NOT EXISTS trending_token_tracker_dev (
  id TEXT PRIMARY KEY,
  token_address TEXT NOT NULL UNIQUE,
  token_symbol TEXT,
  token_name TEXT,
  logo_url TEXT,
  initial_price_usd NUMERIC NOT NULL DEFAULT 0,
  last_price_usd NUMERIC NOT NULL DEFAULT 0,
  peak_price_usd NUMERIC NOT NULL DEFAULT 0,
  current_gain_percentage NUMERIC NOT NULL DEFAULT 0,
  peak_gain_percentage NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'tracking', 'won', 'lost', 'skipped', 'stopped')),
  organic_score NUMERIC,
  market_cap NUMERIC,
  volume_1h NUMERIC,
  volume_5m NUMERIC,
  tracking_started_at TIMESTAMPTZ,
  status_changed_at TIMESTAMPTZ,
  waiting_started_at TIMESTAMPTZ,
  waiting_initial_price NUMERIC,
  trading_simulation JSONB,
  price_history JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trending_tracker_dev_token ON trending_token_tracker_dev(token_address);
CREATE INDEX IF NOT EXISTS idx_trending_tracker_dev_status ON trending_token_tracker_dev(status);

CREATE TABLE IF NOT EXISTS trending_token_summary_dev (
  id TEXT PRIMARY KEY,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  total_tokens_tracked INTEGER NOT NULL DEFAULT 0,
  won_tokens INTEGER NOT NULL DEFAULT 0,
  lost_tokens INTEGER NOT NULL DEFAULT 0,
  still_tracking INTEGER NOT NULL DEFAULT 0,
  win_rate NUMERIC NOT NULL DEFAULT 0,
  top_winners JSONB,
  avg_peak_gain NUMERIC NOT NULL DEFAULT 0,
  max_peak_gain NUMERIC NOT NULL DEFAULT 0,
  avg_loss NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- Market cap tracking & OHLC
-- =============================================================================

CREATE TABLE IF NOT EXISTS token_mcap_tracking (
  token_address TEXT PRIMARY KEY,
  token_symbol TEXT,
  first_mcap NUMERIC NOT NULL DEFAULT 0,
  current_mcap NUMERIC NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mcap_growth_percent NUMERIC,
  when_reach_80pct TIMESTAMPTZ,
  when_reach_120pct TIMESTAMPTZ,
  when_reach_200pct TIMESTAMPTZ,
  when_drop_40pct TIMESTAMPTZ,
  when_drop_80pct TIMESTAMPTZ,
  peak_mcap NUMERIC,
  peak_growth_percent NUMERIC,
  peak_seen_at TIMESTAMPTZ,
  is_tracking_stuck BOOLEAN NOT NULL DEFAULT false,
  label TEXT CHECK (label IN ('valid', 'traded_live', 'potential', 'rugged', 'watching'))
);

CREATE INDEX IF NOT EXISTS idx_token_mcap_growth ON token_mcap_tracking(mcap_growth_percent DESC);
CREATE INDEX IF NOT EXISTS idx_token_mcap_first_seen ON token_mcap_tracking(first_seen_at DESC);
-- idx_token_mcap_label is created in the patches section (after label column is ensured)

CREATE TABLE IF NOT EXISTS mcap_threshold_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address TEXT NOT NULL,
  token_symbol TEXT,
  threshold INTEGER NOT NULL,
  growth_percent NUMERIC,
  notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcap_notifications_token ON mcap_threshold_notifications(token_address, threshold);

CREATE TABLE IF NOT EXISTS token_ohlc_bars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address TEXT NOT NULL,
  interval TEXT NOT NULL CHECK (interval IN ('1m', '5m', '15m', '1h')),
  open NUMERIC NOT NULL,
  high NUMERIC NOT NULL,
  low NUMERIC NOT NULL,
  close NUMERIC NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  UNIQUE (token_address, interval, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_token_ohlc_lookup
  ON token_ohlc_bars(token_address, interval, timestamp);

-- =============================================================================
-- DLMM agent (Meteora liquidity management)
-- =============================================================================

CREATE TABLE IF NOT EXISTS dlmm_agent_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enabled BOOLEAN NOT NULL DEFAULT false,
  dry_run BOOLEAN NOT NULL DEFAULT true,
  min_tvl NUMERIC NOT NULL DEFAULT 50000,
  min_fee_tvl NUMERIC NOT NULL DEFAULT 0.1,
  min_organic_score NUMERIC NOT NULL DEFAULT 50,
  min_holders INTEGER NOT NULL DEFAULT 100,
  take_profit_pct NUMERIC NOT NULL DEFAULT 5,
  stop_loss_pct NUMERIC NOT NULL DEFAULT -10,
  oor_timeout_min INTEGER NOT NULL DEFAULT 16,
  max_sol_per_position NUMERIC NOT NULL DEFAULT 1,
  max_sol_at_risk NUMERIC NOT NULL DEFAULT 5,
  bin_range_interval INTEGER NOT NULL DEFAULT 10,
  muted_positions JSONB NOT NULL DEFAULT '[]'::jsonb,
  use_llm_reasoner BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dlmm_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_address TEXT NOT NULL,
  pool_name TEXT,
  token_x_symbol TEXT,
  token_y_symbol TEXT,
  tvl NUMERIC,
  fee_tvl_ratio_24h NUMERIC,
  organic_score NUMERIC,
  holders INTEGER,
  mcap NUMERIC,
  score NUMERIC,
  screened_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dlmm_candidates_screened ON dlmm_candidates(screened_at DESC);
CREATE INDEX IF NOT EXISTS idx_dlmm_candidates_pool ON dlmm_candidates(pool_address);

-- Manually curated DLMM watchlist (added from Signals / Algo Tester / Board)
CREATE TABLE IF NOT EXISTS dlmm_potential_list (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address TEXT NOT NULL UNIQUE,
  token_symbol TEXT,
  source TEXT NOT NULL DEFAULT 'signals',
  notes TEXT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dlmm_potential_added ON dlmm_potential_list(added_at DESC);
CREATE INDEX IF NOT EXISTS idx_dlmm_potential_token ON dlmm_potential_list(token_address);

-- App-wide rug registry (Signals, Algo Tester, DLMM) — excluded from lists/feeds
CREATE TABLE IF NOT EXISTS token_rug_list (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address TEXT NOT NULL UNIQUE,
  token_symbol TEXT,
  source TEXT NOT NULL DEFAULT 'dlmm-general',
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_rug_added ON token_rug_list(added_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_rug_token ON token_rug_list(token_address);

-- Migrate legacy dlmm_rug_list name if present
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'dlmm_rug_list'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'token_rug_list'
  ) THEN
    ALTER TABLE dlmm_rug_list RENAME TO token_rug_list;
  END IF;
END $$;

-- Backfill from legacy label columns into token_rug_list
INSERT INTO token_rug_list (token_address, token_symbol, source, added_at)
SELECT token_address, token_symbol, 'board', updated_at
FROM trading_signals WHERE label = 'rugged'
ON CONFLICT (token_address) DO NOTHING;

INSERT INTO token_rug_list (token_address, token_symbol, source, added_at)
SELECT token_address, token_symbol, 'tracker', last_updated_at
FROM token_mcap_tracking WHERE label = 'rugged'
ON CONFLICT (token_address) DO NOTHING;

CREATE TABLE IF NOT EXISTS dlmm_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_address TEXT NOT NULL,
  pool_name TEXT,
  position_pubkey TEXT,
  token_x_symbol TEXT,
  token_y_symbol TEXT,
  amount_sol NUMERIC NOT NULL DEFAULT 0,
  min_bin_id INTEGER,
  max_bin_id INTEGER,
  entry_value_usd NUMERIC NOT NULL DEFAULT 0,
  current_value_usd NUMERIC NOT NULL DEFAULT 0,
  fees_earned_usd NUMERIC NOT NULL DEFAULT 0,
  pnl_pct NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed', 'pending', 'out_of_range')),
  is_muted BOOLEAN NOT NULL DEFAULT false,
  oor_since TIMESTAMPTZ,
  take_profit_pct NUMERIC NOT NULL DEFAULT 5,
  stop_loss_pct NUMERIC NOT NULL DEFAULT -10,
  oor_timeout_min INTEGER NOT NULL DEFAULT 16,
  last_decision TEXT,
  last_decision_reason TEXT,
  last_decision_at TIMESTAMPTZ,
  tx_signature TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dlmm_positions_status ON dlmm_positions(status);
CREATE INDEX IF NOT EXISTS idx_dlmm_positions_pool ON dlmm_positions(pool_address);

CREATE TABLE IF NOT EXISTS dlmm_lessons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id UUID REFERENCES dlmm_positions(id) ON DELETE SET NULL,
  pool_address TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  pnl_pct NUMERIC,
  fee_tvl_at_entry NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dlmm_lessons_created ON dlmm_lessons(created_at DESC);

INSERT INTO dlmm_agent_config (enabled, dry_run)
SELECT false, true
WHERE NOT EXISTS (SELECT 1 FROM dlmm_agent_config LIMIT 1);

-- =============================================================================
-- Patches for existing databases (no-op on fresh installs)
-- =============================================================================

ALTER TABLE trending_token_tracker
  DROP CONSTRAINT IF EXISTS trending_token_tracker_status_check;
ALTER TABLE trending_token_tracker
  ADD CONSTRAINT trending_token_tracker_status_check
  CHECK (status IN ('waiting', 'tracking', 'won', 'lost', 'skipped', 'stopped'));

ALTER TABLE trending_token_tracker_dev
  DROP CONSTRAINT IF EXISTS trending_token_tracker_dev_status_check;
ALTER TABLE trending_token_tracker_dev
  DROP CONSTRAINT IF EXISTS trending_token_tracker_status_check;
ALTER TABLE trending_token_tracker_dev
  ADD CONSTRAINT trending_token_tracker_dev_status_check
  CHECK (status IN ('waiting', 'tracking', 'won', 'lost', 'skipped', 'stopped'));

ALTER TABLE trending_token_tracker
  ADD COLUMN IF NOT EXISTS waiting_started_at TIMESTAMPTZ;
ALTER TABLE trending_token_tracker
  ADD COLUMN IF NOT EXISTS waiting_initial_price NUMERIC;
ALTER TABLE trending_token_tracker_dev
  ADD COLUMN IF NOT EXISTS waiting_started_at TIMESTAMPTZ;
ALTER TABLE trending_token_tracker_dev
  ADD COLUMN IF NOT EXISTS waiting_initial_price NUMERIC;

ALTER TABLE trending_token_tracker
  ADD COLUMN IF NOT EXISTS volume_5m NUMERIC;
ALTER TABLE trending_token_tracker_dev
  ADD COLUMN IF NOT EXISTS volume_5m NUMERIC;
ALTER TABLE trending_token_tracker
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;
ALTER TABLE trending_token_tracker_dev
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;
ALTER TABLE trending_token_tracker
  ADD COLUMN IF NOT EXISTS trading_simulation JSONB;
ALTER TABLE trending_token_tracker_dev
  ADD COLUMN IF NOT EXISTS trading_simulation JSONB;
ALTER TABLE trending_token_tracker
  ADD COLUMN IF NOT EXISTS price_history JSONB;
ALTER TABLE trending_token_tracker_dev
  ADD COLUMN IF NOT EXISTS price_history JSONB;

CREATE INDEX IF NOT EXISTS idx_trending_tracker_waiting
  ON trending_token_tracker(status, waiting_started_at) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS idx_trending_tracker_dev_waiting
  ON trending_token_tracker_dev(status, waiting_started_at) WHERE status = 'waiting';

ALTER TABLE token_operations
  ADD COLUMN IF NOT EXISTS trade_pnl NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE token_operations
  ADD COLUMN IF NOT EXISTS last_pnl_update TIMESTAMPTZ;

ALTER TABLE trading_signals
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE token_mcap_tracking
  ADD COLUMN IF NOT EXISTS label TEXT;

ALTER TABLE token_mcap_tracking
  ADD COLUMN IF NOT EXISTS when_drop_40pct TIMESTAMPTZ;
ALTER TABLE token_mcap_tracking
  ADD COLUMN IF NOT EXISTS when_drop_80pct TIMESTAMPTZ;
ALTER TABLE token_mcap_tracking
  ADD COLUMN IF NOT EXISTS peak_mcap NUMERIC;
ALTER TABLE token_mcap_tracking
  ADD COLUMN IF NOT EXISTS peak_growth_percent NUMERIC;
ALTER TABLE token_mcap_tracking
  ADD COLUMN IF NOT EXISTS peak_seen_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_token_mcap_label ON token_mcap_tracking(label);

-- =============================================================================
-- Bot automation state (locks, circuit breaker)
-- =============================================================================

CREATE TABLE IF NOT EXISTS bot_job_locks (
  job_name TEXT PRIMARY KEY,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by TEXT,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_trade_locks (
  token_address TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (token_address, strategy_id)
);

CREATE INDEX IF NOT EXISTS idx_bot_trade_locks_expires ON bot_trade_locks(expires_at);

CREATE TABLE IF NOT EXISTS bot_trading_state (
  id TEXT PRIMARY KEY DEFAULT 'global',
  consecutive_failures INT NOT NULL DEFAULT 0,
  real_trading_halted BOOLEAN NOT NULL DEFAULT false,
  halted_at TIMESTAMPTZ,
  halt_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO bot_trading_state (id) VALUES ('global') ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- Strategy admin (trending bot overrides + ML outcome snapshots)
-- =============================================================================

CREATE TABLE IF NOT EXISTS strategy_definitions (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL CHECK (domain IN ('trending_bot', 'signals', 'dlmm', 'mcap_tracker', 'gmgn')),
  name TEXT NOT NULL,
  description TEXT,
  config JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  execution_mode TEXT NOT NULL DEFAULT 'sim_only' CHECK (execution_mode IN ('sim_only', 'live_only', 'ab_parallel')),
  version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS strategy_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('trending_bot', 'signals', 'dlmm', 'mcap_tracker', 'gmgn')),
  token_address TEXT,
  entry_at TIMESTAMPTZ,
  exit_at TIMESTAMPTZ,
  pnl_pct NUMERIC,
  status TEXT,
  is_simulated BOOLEAN NOT NULL DEFAULT true,
  features JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_strategy_outcomes_strategy ON strategy_outcomes(strategy_id);
CREATE INDEX IF NOT EXISTS idx_strategy_outcomes_created ON strategy_outcomes(created_at DESC);

-- Phase 2 migration (run BEFORE index on is_simulated — safe on existing Phase 1 DBs)
ALTER TABLE strategy_definitions ADD COLUMN IF NOT EXISTS execution_mode TEXT DEFAULT 'sim_only';
UPDATE strategy_definitions SET execution_mode = 'sim_only' WHERE execution_mode IS NULL;
ALTER TABLE strategy_definitions ALTER COLUMN execution_mode SET DEFAULT 'sim_only';

ALTER TABLE strategy_outcomes ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN DEFAULT true;
UPDATE strategy_outcomes SET is_simulated = COALESCE((features->>'is_simulated')::boolean, true) WHERE is_simulated IS NULL;
ALTER TABLE strategy_outcomes ALTER COLUMN is_simulated SET DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_strategy_outcomes_domain_sim ON strategy_outcomes(domain, strategy_id, is_simulated, exit_at DESC);

INSERT INTO strategy_definitions (id, domain, name, description, config, is_active, execution_mode)
VALUES
  ('att', 'trending_bot', 'Attention Strategy', 'Original aggressive trading strategy', '{}', true, 'sim_only'),
  ('lowcap_moonbag', 'trending_bot', 'Low cap moonbag', 'Lower risk steady gains', '{}', true, 'sim_only'),
  ('scalper', 'trending_bot', 'Scalping Strategy', 'Quick profits fast exits', '{}', false, 'sim_only'),
  ('hodl', 'trending_bot', 'HODL Strategy', 'Long-term holding', '{}', false, 'sim_only'),
  ('signals_default', 'signals', 'Default momentum', 'Enter on strong growth + score floor', '{}', true, 'sim_only'),
  ('signals_sell_over_100', 'signals', 'Sell over 100%', 'Favor exit above 100% growth', '{}', true, 'sim_only'),
  ('dlmm_default', 'dlmm', 'DLMM Hunter/Healer', 'Meteora LP screener + reasoner thresholds', '{}', true, 'sim_only'),
  ('mcap_enter_first_seen', 'mcap_tracker', 'Enter at first seen', 'Paper trade at mcap tracking start', '{}', true, 'sim_only'),
  ('mcap_enter_at_80', 'mcap_tracker', 'Enter at 80% milestone', 'Paper trade when 80% growth milestone hit', '{}', true, 'sim_only'),
  ('gmgn_smartmoney_default', 'gmgn', 'GMGN Smart Money', 'Enter on fresh smart-money buys passing GMGN security gate', '{}', false, 'sim_only'),
  ('gmgn_kol_momentum', 'gmgn', 'GMGN KOL Momentum', 'Enter on fresh KOL buys passing GMGN security gate', '{}', false, 'sim_only')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE bot_job_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_trade_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_trading_state ENABLE ROW LEVEL SECURITY;


ALTER TABLE token_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE sl_tp_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE trending_token_tracker ENABLE ROW LEVEL SECURITY;
ALTER TABLE trending_token_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE trending_token_tracker_dev ENABLE ROW LEVEL SECURITY;
ALTER TABLE trending_token_summary_dev ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_mcap_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcap_threshold_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_ohlc_bars ENABLE ROW LEVEL SECURITY;
ALTER TABLE dlmm_agent_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE dlmm_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE dlmm_potential_list ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_rug_list ENABLE ROW LEVEL SECURITY;
ALTER TABLE dlmm_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dlmm_lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_outcomes ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS market_regime_tags (
  tag_date DATE PRIMARY KEY,
  regime_tag TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_market_regime_tags_updated
  ON market_regime_tags (updated_at DESC);

-- Per-wallet global watchlist (GMGN charts, nav bar)
CREATE TABLE IF NOT EXISTS wallet_watchlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  token_symbol TEXT,
  logo_url TEXT,
  initial_price_usd NUMERIC,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (wallet_address, token_address)
);

ALTER TABLE wallet_watchlist ADD COLUMN IF NOT EXISTS initial_price_usd NUMERIC;

CREATE INDEX IF NOT EXISTS idx_wallet_watchlist_wallet ON wallet_watchlist(wallet_address, added_at DESC);

ALTER TABLE wallet_watchlist ENABLE ROW LEVEL SECURITY;

-- Ensure status check allows 'stopped' before ghost cleanup (dev mirror may use prod constraint name).
ALTER TABLE trending_token_tracker
  DROP CONSTRAINT IF EXISTS trending_token_tracker_status_check;
ALTER TABLE trending_token_tracker
  ADD CONSTRAINT trending_token_tracker_status_check
  CHECK (status IN ('waiting', 'tracking', 'won', 'lost', 'skipped', 'stopped'));

ALTER TABLE trending_token_tracker_dev
  DROP CONSTRAINT IF EXISTS trending_token_tracker_dev_status_check;
ALTER TABLE trending_token_tracker_dev
  DROP CONSTRAINT IF EXISTS trending_token_tracker_status_check;
ALTER TABLE trending_token_tracker_dev
  ADD CONSTRAINT trending_token_tracker_dev_status_check
  CHECK (status IN ('waiting', 'tracking', 'won', 'lost', 'skipped', 'stopped'));

-- One-time idempotent cleanup: stop ghost "tracking" rows with no active holding simulation.
UPDATE trending_token_tracker
SET status = 'stopped', updated_at = NOW()
WHERE status = 'tracking'
  AND (
    trading_simulation IS NULL
    OR COALESCE(trading_simulation->>'current_status', '') <> 'holding'
    OR COALESCE(trading_simulation->'buy_operation'->>'bot_strategy', '') = ''
    OR COALESCE((trading_simulation->>'remaining_token_amount')::numeric, 0) < 0.000001
  );

UPDATE trending_token_tracker_dev
SET status = 'stopped', updated_at = NOW()
WHERE status = 'tracking'
  AND (
    trading_simulation IS NULL
    OR COALESCE(trading_simulation->>'current_status', '') <> 'holding'
    OR COALESCE(trading_simulation->'buy_operation'->>'bot_strategy', '') = ''
    OR COALESCE((trading_simulation->>'remaining_token_amount')::numeric, 0) < 0.000001
  );

-- =============================================================================
-- Social + smart-wallet signal tables
-- =============================================================================

CREATE TABLE IF NOT EXISTS tracked_wallets (
  address TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'tier2' CHECK (tier IN ('tier1', 'tier2')),
  tags TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_polled_at TIMESTAMPTZ,
  last_poll_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tracked_wallets_active
  ON tracked_wallets (is_active, tier);

CREATE TABLE IF NOT EXISTS tracked_wallet_holdings (
  wallet_address TEXT NOT NULL REFERENCES tracked_wallets (address) ON DELETE CASCADE,
  token_address TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (wallet_address, token_address)
);

CREATE INDEX IF NOT EXISTS idx_tracked_wallet_holdings_token
  ON tracked_wallet_holdings (token_address, first_seen_at DESC);

CREATE TABLE IF NOT EXISTS social_token_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('mention', 'wallet_buy', 'wallet_sell')),
  source TEXT NOT NULL,
  channel_id TEXT,
  channel_label TEXT,
  wallet_address TEXT,
  wallet_label TEXT,
  external_message_id TEXT,
  dedupe_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_social_token_events_dedupe
  ON social_token_events (dedupe_key);

CREATE INDEX IF NOT EXISTS idx_social_token_events_token_time
  ON social_token_events (token_address, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_social_token_events_source_time
  ON social_token_events (source, occurred_at DESC);

CREATE TABLE IF NOT EXISTS social_token_rollups (
  token_address TEXT PRIMARY KEY,
  first_seen_at TIMESTAMPTZ,
  first_source TEXT,
  first_channel TEXT,
  mention_count_5m INT NOT NULL DEFAULT 0,
  mention_count_30m INT NOT NULL DEFAULT 0,
  mention_count_24h INT NOT NULL DEFAULT 0,
  unique_channel_count_30m INT NOT NULL DEFAULT 0,
  smart_wallet_buy_count_1h INT NOT NULL DEFAULT 0,
  smart_wallet_buy_sol_1h NUMERIC NOT NULL DEFAULT 0,
  top_source TEXT,
  last_event_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_social_token_rollups_updated
  ON social_token_rollups (updated_at DESC);

ALTER TABLE tracked_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_wallet_holdings ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_token_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_token_rollups ENABLE ROW LEVEL SECURITY;

