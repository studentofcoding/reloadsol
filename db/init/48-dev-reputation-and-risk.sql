-- Dev reputation lists + RugCheck risk features (shadow-first v1).
--
-- Two capabilities, both SHADOW-FIRST: they record and display a verdict but change
-- no trading behaviour until the correlation data proves an effect AND the env mode is
-- flipped. Kill switches: RUGCHECK_ENABLED=false, DEV_REPUTATION_ENABLED=false,
-- DEV_REPUTATION_MODE=shadow (see src/strategies/risk-label.ts + risk-shadow.ts).
--
-- Sources (verified live, do not reopen):
--   * GMGN GET /v1/user/created_tokens — the ONLY dev coin-history source
--     (graduation rate + per-coin ATH). Total created = inner_count + open_count;
--     the tokens[] array caps at 100, so score off the aggregates.
--   * RugCheck GET /v1/tokens/{id}/report — free/keyless per-token on-chain risk
--     (score_normalised, named risks, insider graph, LP lock, creator balance).
--     It has NO creator-history endpoint; Jupiter gives the dev address only.
--
-- token_risk_features is the latest per-token view (read by the Freeview tiles / API).
-- dev_reputation is the durable per-creator record with a re-eval TTL so a dev can
-- rehabilitate. Both are best-effort writes that never block a tick.

CREATE TABLE IF NOT EXISTS token_risk_features (
  chain TEXT NOT NULL,
  token_address TEXT NOT NULL,
  creator_address TEXT,
  -- RugCheck (sol only)
  rugcheck_score REAL,
  rugcheck_score_norm REAL,
  rugcheck_risk_names TEXT[] NOT NULL DEFAULT '{}',
  rugcheck_risk_points INTEGER,
  rugcheck_insiders INTEGER,
  rugcheck_lp_locked_pct REAL,
  rugcheck_locker_status TEXT,
  rugcheck_mutable_meta BOOLEAN,
  rugcheck_rugged BOOLEAN,
  creator_balance NUMERIC,
  -- Dev reputation (from dev_reputation)
  dev_verdict TEXT NOT NULL DEFAULT 'unknown'
    CHECK (dev_verdict IN ('ban', 'good', 'inconclusive', 'unknown')),
  dev_sample INTEGER,
  dev_graduation_ratio REAL,
  dev_ath_mc NUMERIC,
  dev_reasons TEXT[] NOT NULL DEFAULT '{}',
  -- display
  risk_label TEXT,
  risk_reasons TEXT[] NOT NULL DEFAULT '{}',
  mode TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow', 'enforce')),
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain, token_address)
);

CREATE INDEX IF NOT EXISTS token_risk_features_updated_idx
  ON token_risk_features (updated_at DESC);

CREATE INDEX IF NOT EXISTS token_risk_features_creator_idx
  ON token_risk_features (chain, creator_address);

CREATE TABLE IF NOT EXISTS dev_reputation (
  chain TEXT NOT NULL,
  creator_address TEXT NOT NULL,
  sample INTEGER NOT NULL DEFAULT 0,
  open_count INTEGER NOT NULL DEFAULT 0,
  inner_count INTEGER NOT NULL DEFAULT 0,
  graduation_ratio REAL,
  ath_mc NUMERIC,
  verdict TEXT NOT NULL DEFAULT 'unknown'
    CHECK (verdict IN ('ban', 'good', 'inconclusive', 'unknown')),
  reasons TEXT[] NOT NULL DEFAULT '{}',
  mode TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow', 'enforce')),
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  re_eval_after TIMESTAMPTZ,
  PRIMARY KEY (chain, creator_address)
);

CREATE INDEX IF NOT EXISTS dev_reputation_verdict_idx
  ON dev_reputation (verdict, evaluated_at DESC);

ALTER TABLE token_risk_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_reputation ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE token_risk_features IS
  'Latest shadow risk snapshot per token: RugCheck on-chain risk + dev verdict. Display-only until enforced.';

COMMENT ON TABLE dev_reputation IS
  'Durable per-creator dev reputation (graduation ratio + ATH). Shadow-first; re_eval_after drives TTL re-evaluation.';
