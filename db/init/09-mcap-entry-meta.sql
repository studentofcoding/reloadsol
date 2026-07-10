-- Entry meta for ML feature recovery (organic / holders / volume)
ALTER TABLE token_mcap_tracking
  ADD COLUMN IF NOT EXISTS organic_score NUMERIC;
ALTER TABLE token_mcap_tracking
  ADD COLUMN IF NOT EXISTS top_holders_pct NUMERIC;
ALTER TABLE token_mcap_tracking
  ADD COLUMN IF NOT EXISTS volume_5m NUMERIC;
