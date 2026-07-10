-- GMGN SM+KOL combined strategy seed

INSERT INTO strategy_definitions (id, domain, name, description, config, is_active, execution_mode)
VALUES
  (
    'gmgn_sm_kol_combined',
    'gmgn',
    'GMGN SM + KOL Combined',
    'Score-sorted discovery from smart money and KOL feeds (60m activity window)',
    '{}',
    false,
    'sim_only'
  )
ON CONFLICT (id) DO NOTHING;
