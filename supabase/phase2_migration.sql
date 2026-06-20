-- Phase 2: run this in Supabase SQL editor if strategy_definitions/outcomes already exist from Phase 1.
-- Your screenshot shows strategy_definitions seeds are OK — you likely only need the strategy_outcomes part.

-- 1. execution_mode on strategy_definitions (skip if already done)
ALTER TABLE strategy_definitions ADD COLUMN IF NOT EXISTS execution_mode TEXT DEFAULT 'sim_only';
UPDATE strategy_definitions SET execution_mode = 'sim_only' WHERE execution_mode IS NULL;

-- 2. is_simulated on strategy_outcomes (fixes "column is_simulated does not exist")
ALTER TABLE strategy_outcomes ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN DEFAULT true;
UPDATE strategy_outcomes
SET is_simulated = COALESCE((features->>'is_simulated')::boolean, true)
WHERE is_simulated IS NULL;

-- 3. Index for reports (only after column exists)
CREATE INDEX IF NOT EXISTS idx_strategy_outcomes_domain_sim
  ON strategy_outcomes (domain, strategy_id, is_simulated, exit_at DESC);

-- 4. Seed signals + dlmm rows (safe — ON CONFLICT skips existing)
INSERT INTO strategy_definitions (id, domain, name, description, config, is_active, execution_mode)
VALUES
  ('signals_default', 'signals', 'Default momentum', 'Enter on strong growth + score floor', '{}', true, 'sim_only'),
  ('signals_sell_over_100', 'signals', 'Sell over 100%', 'Favor exit above 100% growth', '{}', true, 'sim_only'),
  ('dlmm_default', 'dlmm', 'DLMM Hunter/Healer', 'Meteora LP screener + reasoner thresholds', '{}', true, 'sim_only')
ON CONFLICT (id) DO NOTHING;

-- 5. Verify
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'strategy_outcomes' AND column_name = 'is_simulated';

SELECT id, domain, execution_mode FROM strategy_definitions
WHERE domain IN ('signals', 'dlmm', 'trending_bot')
ORDER BY domain, id;
