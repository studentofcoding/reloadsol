-- Robinhood strategy twins as first-class strategy_definitions rows.
--
-- The RH twins already exist in the TS registry (src/strategies/registry.ts) with
-- chain='robinhood', but had no DB row. The registry read is chain-scoped
-- (WHERE domain = $1 AND chain = $2) while upsertStrategyDefinition used to omit
-- `chain`, so an Admin toggle wrote chain='sol' and silently no-opped for every
-- RH twin. These rows make them visible + toggleable from Admin.
--
-- Idempotent and behaviour-neutral: config '{}' lets the registry defaults win, and
-- is_active matches each registry default exactly.

-- Repair rows written by the old (chain-less) upsert, if any.
UPDATE strategy_definitions
   SET chain = 'robinhood'
 WHERE chain <> 'robinhood'
   AND id IN (
     'att_rh',
     'signals_default_rh',
     'mcap_enter_first_seen_rh',
     'mcap_enter_at_80_rh',
     'gmgn_smartmoney_rh',
     'gmgn_kol_momentum_rh'
   );

INSERT INTO strategy_definitions (
  id, domain, chain, name, description, config, is_active, execution_mode, updated_at
) VALUES
  ('att_rh', 'trending_bot', 'robinhood', 'Attention Strategy (Robinhood)',
   'Attention on GMGN robinhood market rank — paper only', '{}'::jsonb, true, 'sim_only', NOW()),
  ('signals_default_rh', 'signals', 'robinhood', 'Default momentum (Robinhood)',
   'Enter on strong growth + score floor, robinhood mcap tracking', '{}'::jsonb, true, 'sim_only', NOW()),
  ('mcap_enter_first_seen_rh', 'mcap_tracker', 'robinhood', 'Enter at first seen (Robinhood)',
   'Paper trade when a robinhood token enters mcap tracking', '{}'::jsonb, true, 'sim_only', NOW()),
  ('mcap_enter_at_80_rh', 'mcap_tracker', 'robinhood', 'Enter at 80% milestone (Robinhood)',
   'Paper trade when a robinhood token reaches 80% mcap growth', '{}'::jsonb, true, 'sim_only', NOW()),
  ('gmgn_smartmoney_rh', 'gmgn', 'robinhood', 'GMGN Smart Money (Robinhood)',
   'Enter on fresh robinhood smart-money buys that pass the GMGN security gate', '{}'::jsonb, false, 'sim_only', NOW()),
  ('gmgn_kol_momentum_rh', 'gmgn', 'robinhood', 'GMGN KOL Momentum (Robinhood)',
   'Enter on fresh robinhood KOL buys that pass the GMGN security gate', '{}'::jsonb, false, 'sim_only', NOW())
ON CONFLICT (id) DO NOTHING;
