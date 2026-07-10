-- GMGN strategy domain (smart money / KOL paper trading via gmgn-cli)

ALTER TABLE strategy_definitions
  DROP CONSTRAINT IF EXISTS strategy_definitions_domain_check;
ALTER TABLE strategy_definitions
  ADD CONSTRAINT strategy_definitions_domain_check
  CHECK (domain IN ('trending_bot', 'signals', 'dlmm', 'mcap_tracker', 'gmgn'));

ALTER TABLE strategy_outcomes
  DROP CONSTRAINT IF EXISTS strategy_outcomes_domain_check;
ALTER TABLE strategy_outcomes
  ADD CONSTRAINT strategy_outcomes_domain_check
  CHECK (domain IN ('trending_bot', 'signals', 'dlmm', 'mcap_tracker', 'gmgn'));

INSERT INTO strategy_definitions (id, domain, name, description, config, is_active, execution_mode)
VALUES
  ('gmgn_smartmoney_default', 'gmgn', 'GMGN Smart Money', 'Enter on fresh smart-money buys passing GMGN security gate', '{}', false, 'sim_only'),
  ('gmgn_kol_momentum', 'gmgn', 'GMGN KOL Momentum', 'Enter on fresh KOL buys passing GMGN security gate', '{}', false, 'sim_only')
ON CONFLICT (id) DO NOTHING;
