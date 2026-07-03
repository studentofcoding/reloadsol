-- Token locate: fast lookup of strategy outcomes by mint address
CREATE INDEX IF NOT EXISTS idx_strategy_outcomes_token_exit
  ON strategy_outcomes (token_address, exit_at DESC NULLS LAST)
  WHERE token_address IS NOT NULL;
