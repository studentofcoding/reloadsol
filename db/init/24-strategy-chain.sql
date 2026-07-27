-- Strategy chain dimension: one definition row per chain (sol | robinhood),
-- outcomes and mcap tracking stamped with the chain they belong to.
-- Existing rows default to sol.

ALTER TABLE strategy_definitions
  ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'sol';

CREATE INDEX IF NOT EXISTS idx_strategy_definitions_chain_domain
  ON strategy_definitions (chain, domain);

ALTER TABLE strategy_outcomes
  ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'sol';

CREATE INDEX IF NOT EXISTS idx_strategy_outcomes_chain_strategy
  ON strategy_outcomes (chain, strategy_id);

-- mcap tracking is the candidate supply for the signals / mcap_tracker domains.
ALTER TABLE token_mcap_tracking
  ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'sol';

CREATE INDEX IF NOT EXISTS idx_token_mcap_tracking_chain_updated
  ON token_mcap_tracking (chain, last_updated_at DESC);

-- Same token address can legitimately exist on both chains, so the
-- duplicate-outcome guard has to include the chain.
CREATE INDEX IF NOT EXISTS idx_strategy_outcomes_dedupe
  ON strategy_outcomes (chain, strategy_id, token_address, entry_at);
