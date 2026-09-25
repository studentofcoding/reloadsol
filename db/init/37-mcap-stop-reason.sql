-- Manual stop / dismiss for token_mcap_tracking (used by Tracker ⛔ and list hide).
ALTER TABLE token_mcap_tracking
  ADD COLUMN IF NOT EXISTS stop_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_token_mcap_stop_reason
  ON token_mcap_tracking (stop_reason)
  WHERE stop_reason IS NOT NULL;
