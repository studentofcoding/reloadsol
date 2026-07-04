-- Milestone timestamps are growth-percent thresholds (80/120/200%), not market-cap dollar levels.
-- Safe to run on fresh installs (columns already named *_pct in 02-schema.sql) — use IF EXISTS pattern via DO block.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'token_mcap_tracking' AND column_name = 'when_reach_80mc'
  ) THEN
    ALTER TABLE token_mcap_tracking RENAME COLUMN when_reach_80mc TO when_reach_80pct;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'token_mcap_tracking' AND column_name = 'when_reach_120mc'
  ) THEN
    ALTER TABLE token_mcap_tracking RENAME COLUMN when_reach_120mc TO when_reach_120pct;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'token_mcap_tracking' AND column_name = 'when_reach_200mc'
  ) THEN
    ALTER TABLE token_mcap_tracking RENAME COLUMN when_reach_200mc TO when_reach_200pct;
  END IF;
END $$;
