-- token_risk_features: GMGN internal web fields (batch safety + token_stat).
--
-- Source: GMGN's internal endpoints reached via our `gmgn-web-proxy` worker
-- (verified 200 server-side, no browser):
--   POST /api/v1/meme_quote_info  → is_honeypot, is_safe, liquidity
--   GET  /api/v1/token_stat/sol/{mint} → bundler / rat / entrapment / bot-degen %
--
-- Display + correlation only; nothing gates on these. Additive + idempotent;
-- the runtime ensure in src/strategies/risk-store.ts mirrors it.

ALTER TABLE token_risk_features ADD COLUMN IF NOT EXISTS gmgn_is_safe BOOLEAN;
ALTER TABLE token_risk_features ADD COLUMN IF NOT EXISTS gmgn_is_honeypot BOOLEAN;
ALTER TABLE token_risk_features ADD COLUMN IF NOT EXISTS gmgn_liquidity_usd NUMERIC;
ALTER TABLE token_risk_features ADD COLUMN IF NOT EXISTS gmgn_bundler_pct REAL;
ALTER TABLE token_risk_features ADD COLUMN IF NOT EXISTS gmgn_rat_pct REAL;
ALTER TABLE token_risk_features ADD COLUMN IF NOT EXISTS gmgn_entrapment_pct REAL;
ALTER TABLE token_risk_features ADD COLUMN IF NOT EXISTS gmgn_bot_degen_pct REAL;

COMMENT ON COLUMN token_risk_features.gmgn_is_safe IS
  'GMGN internal meme_quote_info is_safe (yes/no). Shadow-only.';
COMMENT ON COLUMN token_risk_features.gmgn_bundler_pct IS
  'GMGN internal token_stat top_bundler_trader_percentage, as percent.';
