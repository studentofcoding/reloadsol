-- Add chain dimension to social tables so RH (lowercase 0x) mints don't
-- collide with their Sol twins. Same mint can exist on both chains.

ALTER TABLE social_token_events
  ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'sol';

CREATE INDEX IF NOT EXISTS idx_social_token_events_chain_token
  ON social_token_events (chain, token_address, occurred_at DESC);

ALTER TABLE social_token_rollups
  ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'sol';

CREATE INDEX IF NOT EXISTS idx_social_token_rollups_chain_token
  ON social_token_rollups (chain, token_address);
