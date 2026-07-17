-- Social strategy domain (social-only FOMO paper trading)

ALTER TABLE strategy_definitions
  DROP CONSTRAINT IF EXISTS strategy_definitions_domain_check;
ALTER TABLE strategy_definitions
  ADD CONSTRAINT strategy_definitions_domain_check
  CHECK (domain IN ('trending_bot', 'signals', 'dlmm', 'mcap_tracker', 'gmgn', 'social'));

ALTER TABLE strategy_outcomes
  DROP CONSTRAINT IF EXISTS strategy_outcomes_domain_check;
ALTER TABLE strategy_outcomes
  ADD CONSTRAINT strategy_outcomes_domain_check
  CHECK (domain IN ('trending_bot', 'signals', 'dlmm', 'mcap_tracker', 'gmgn', 'social'));

INSERT INTO strategy_definitions (id, domain, name, description, config, is_active, execution_mode)
VALUES
  (
    'social_only_fomo_gt7',
    'social',
    'Social-only FOMO (>7)',
    'Paper trade when FOMO mentions >7 in 30m and token is only on social_token_rollups',
    '{}',
    true,
    'sim_only'
  )
ON CONFLICT (id) DO NOTHING;
