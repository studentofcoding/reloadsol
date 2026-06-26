-- One-time repair: first_seen_at must not be later than milestone timestamps.
-- Run after deploying mcap-tracker timeline fix.

UPDATE token_mcap_tracking
SET first_seen_at = LEAST(
  first_seen_at,
  COALESCE(when_reach_80mc, first_seen_at),
  COALESCE(when_reach_120mc, first_seen_at),
  COALESCE(when_reach_200mc, first_seen_at)
)
WHERE when_reach_80mc IS NOT NULL
  AND first_seen_at > when_reach_80mc;

-- Extend strategy domain enum for mcap_tracker sim outcomes (idempotent via drop/recreate check)
ALTER TABLE strategy_definitions DROP CONSTRAINT IF EXISTS strategy_definitions_domain_check;
ALTER TABLE strategy_definitions ADD CONSTRAINT strategy_definitions_domain_check
  CHECK (domain IN ('trending_bot', 'signals', 'dlmm', 'mcap_tracker'));

ALTER TABLE strategy_outcomes DROP CONSTRAINT IF EXISTS strategy_outcomes_domain_check;
ALTER TABLE strategy_outcomes ADD CONSTRAINT strategy_outcomes_domain_check
  CHECK (domain IN ('trending_bot', 'signals', 'dlmm', 'mcap_tracker'));

INSERT INTO strategy_definitions (id, domain, name, description, config, is_active, execution_mode)
VALUES
  (
    'mcap_enter_first_seen',
    'mcap_tracker',
    'Enter at first seen',
    'Paper trade when token enters mcap tracking (first_mcap baseline)',
    '{}',
    true,
    'sim_only'
  ),
  (
    'mcap_enter_at_80',
    'mcap_tracker',
    'Enter at 80% milestone',
    'Paper trade when token reaches 80% mcap growth milestone',
    '{}',
    true,
    'sim_only'
  )
ON CONFLICT (id) DO NOTHING;
