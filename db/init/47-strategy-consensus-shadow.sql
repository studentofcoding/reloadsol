-- Shadow log for the strategy-consensus gate.
--
-- A consensus gate would require N independent strategy FAMILIES to already agree on
-- a mint before opening. It is NOT enforced: the evidence for "agreement predicts the
-- outcome" is inconclusive (by family, +120% at 1 family n=238, +255% at 2 n=18,
-- +157% at 3 n=3 — up then down), so this table records what the gate WOULD have
-- decided on every would-be open, and nothing changes any trading behaviour until
--    CONSENSUS_GATE_MODE=enforce
-- (kill switch CONSENSUS_GATE_KILL_SWITCH forces shadow; CONSENSUS_GATE_MODE=off
-- disables recording entirely). Same pattern as social_fomo_noul_shadow.
--
-- `decision` is 'no_evidence' whenever the consensus test is not significant at
-- CONSENSUS_GATE_MIN_FAMILIES, so the gate cannot act on an unproven signal: read
-- would_gate rows as "if this were enforced, we would have skipped this open".
--
-- The reader is GET /api/strategies/consensus-shadow.

CREATE TABLE IF NOT EXISTS strategy_consensus_shadow (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  chain TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  token_address TEXT NOT NULL,
  symbol TEXT,
  /** Independent families that had already entered this mint at decision time. */
  family_count INTEGER NOT NULL,
  families TEXT[] NOT NULL DEFAULT '{}',
  strategies TEXT[] NOT NULL DEFAULT '{}',
  min_families INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('would_gate', 'would_pass', 'no_evidence')),
  reason TEXT NOT NULL,
  evidence_significant BOOLEAN NOT NULL DEFAULT FALSE,
  evidence_reason TEXT,
  mode TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow', 'enforce'))
);

CREATE INDEX IF NOT EXISTS strategy_consensus_shadow_created_idx
  ON strategy_consensus_shadow (created_at DESC);

CREATE INDEX IF NOT EXISTS strategy_consensus_shadow_decision_idx
  ON strategy_consensus_shadow (decision, created_at DESC);

CREATE INDEX IF NOT EXISTS strategy_consensus_shadow_token_idx
  ON strategy_consensus_shadow (chain, token_address, created_at DESC);

ALTER TABLE strategy_consensus_shadow ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE strategy_consensus_shadow IS
  'Shadow log for the (unproven) strategy-consensus gate. Opens stay owned by the existing gates until CONSENSUS_GATE_MODE=enforce, which itself only acts when the consensus test is significant.';
