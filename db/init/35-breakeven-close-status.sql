-- Widen trending tracker status so a flat close can be recorded as breakeven.
-- Does not rewrite historical rows (old flats may still say 'won').
-- Rank queries use pnl, not this status, and exclude flats from the win numerator.

ALTER TABLE trending_token_tracker
  DROP CONSTRAINT IF EXISTS trending_token_tracker_status_check;
ALTER TABLE trending_token_tracker
  ADD CONSTRAINT trending_token_tracker_status_check
  CHECK (status IN ('waiting', 'tracking', 'won', 'lost', 'breakeven', 'skipped', 'stopped'));

ALTER TABLE trending_token_tracker_dev
  DROP CONSTRAINT IF EXISTS trending_token_tracker_dev_status_check;
ALTER TABLE trending_token_tracker_dev
  DROP CONSTRAINT IF EXISTS trending_token_tracker_status_check;
ALTER TABLE trending_token_tracker_dev
  ADD CONSTRAINT trending_token_tracker_dev_status_check
  CHECK (status IN ('waiting', 'tracking', 'won', 'lost', 'breakeven', 'skipped', 'stopped'));
