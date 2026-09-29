-- Dev reputation: persist the creator's top tokens with the row, so the dev UI
-- needs no GMGN call to show a dev's coins. Additive + idempotent; the runtime
-- ensure in src/strategies/risk-store.ts mirrors this ALTER.

ALTER TABLE dev_reputation
  ADD COLUMN IF NOT EXISTS tokens JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN dev_reputation.tokens IS
  'Top <=10 created tokens by ATH market cap: [{address,symbol,athMc,marketCap,liquidity,holders,graduated,launchpad,createdAt}].';
