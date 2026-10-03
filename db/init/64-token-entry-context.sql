-- Entry-time context freeze (SPEC-entry-context-freeze-v1), an extension of the immutable Token Info
-- ledger (token_info_detect, db/init/42).
--
-- One INSERT-ONLY row per (chain, token_address), written at the first detect by ANY strategy. It
-- freezes what a later verdict needs and what is otherwise overwritten or pruned: the tracker's
-- first/current mcap, the live Jupiter mcap at detect, a copy of the Token Info tiles when the ledger
-- already holds them, and the last N 1m bars before the detect (token_ohlc_bars is a 48 h window).
--
-- Immutable by construction: a trigger rejects UPDATE and DELETE. (Escape hatch for an operator who
-- really must delete: SET LOCAL reloadsol.allow_entry_context_delete = 'on' inside the transaction.)
-- Additive and idempotent: safe to apply before the code lands (AGENTS.md § Deploy chain 7).

CREATE TABLE IF NOT EXISTS token_entry_context (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain TEXT NOT NULL CHECK (chain IN ('sol', 'robinhood')),
  token_address TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL,
  detecting_strategy TEXT NOT NULL,
  source TEXT NOT NULL,
  -- Wall-clock gap between the seam's detect and this freeze (the Token Info capture can wait on GMGN's gate).
  capture_lag_ms INTEGER,

  -- token_mcap_tracking at freeze time (mutable there; copied here)
  tracker_first_mcap NUMERIC,
  tracker_current_mcap NUMERIC,
  tracker_first_seen_at TIMESTAMPTZ,
  tracker_label TEXT,
  tracker_status TEXT NOT NULL DEFAULT 'absent' CHECK (tracker_status IN ('ok', 'absent', 'error')),

  -- live Jupiter market hints at freeze time (shared cache/queue; no GMGN call)
  jup_mcap NUMERIC,
  jup_usd_price NUMERIC,
  jup_volume_5m NUMERIC,
  jup_fetched_at TIMESTAMPTZ,
  jup_status TEXT NOT NULL DEFAULT 'disabled' CHECK (jup_status IN ('ok', 'unavailable', 'timeout', 'disabled')),

  -- Token Info tiles copied from token_info_detect when its row exists (NULL = not frozen yet; join later)
  token_info JSONB,
  token_info_status TEXT NOT NULL DEFAULT 'absent' CHECK (token_info_status IN ('ledger', 'absent', 'error')),

  -- last N 1m bars strictly before detected_at, oldest first: [{t,o,h,l,c,v}]
  pre_entry_bars JSONB NOT NULL DEFAULT '[]'::jsonb,
  pre_entry_bars_n INTEGER NOT NULL DEFAULT 0,
  pre_entry_last_bar_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain, token_address)
);

CREATE INDEX IF NOT EXISTS idx_token_entry_context_created ON token_entry_context (created_at DESC);

CREATE OR REPLACE FUNCTION token_entry_context_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('reloadsol.allow_entry_context_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'token_entry_context is insert-only (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_token_entry_context_immutable ON token_entry_context;
CREATE TRIGGER trg_token_entry_context_immutable
  BEFORE UPDATE OR DELETE ON token_entry_context
  FOR EACH ROW EXECUTE FUNCTION token_entry_context_immutable();

ALTER TABLE token_entry_context ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE token_entry_context IS
  'Insert-only entry-time context per mint, frozen at the first detect by any strategy. See SPEC-entry-context-freeze-v1.';
