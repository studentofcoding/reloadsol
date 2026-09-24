-- Covering-ish index for Signals picker lean PnL GROUP BY
-- (chain + is_simulated + strategy_id → COUNT / AVG / SUM pnl_pct).
CREATE INDEX IF NOT EXISTS idx_strategy_outcomes_list_pnl
  ON strategy_outcomes (chain, is_simulated, strategy_id)
  INCLUDE (pnl_pct, domain);
