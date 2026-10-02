-- token_risk_features: locked-liquidity USD (from RugCheck `lockers[].usdcLocked`).
--
-- Context: `rugcheck_lp_locked_pct` was populated 0/417 because the full
-- `/v1/tokens/{id}/report` carries no top-level `lpLockedPct` — the value lives
-- per market at `markets[].lp.lpLockedPct`. The reader is fixed in
-- src/strategies/rugcheck-features.ts; this adds the companion USD figure.
--
-- Additive + idempotent; the runtime ensure in src/strategies/risk-store.ts mirrors it.

ALTER TABLE token_risk_features
  ADD COLUMN IF NOT EXISTS rugcheck_lp_locked_usd NUMERIC;

COMMENT ON COLUMN token_risk_features.rugcheck_lp_locked_usd IS
  'Sum of RugCheck report lockers[].usdcLocked (locked liquidity, USD).';
