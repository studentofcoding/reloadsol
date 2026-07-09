-- Drop milestones (-40% / -80%) and peak profit tracking on token_mcap_tracking.
-- Safe to re-run (IF NOT EXISTS).

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
