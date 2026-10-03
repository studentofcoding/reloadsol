-- Evidence archive ledger (SPEC-evidence-bar-archive-v1).
--
-- One row per (dataset, UTC day) attempt to copy a day of evidence from Postgres into the append-only
-- R2 archive. Rows are only ever INSERTed (history of attempts is itself evidence); "is this day safe to
-- prune" is the existence of a row with status 'ok' or 'empty'.
--
-- Additive and idempotent: safe to apply before the code lands (AGENTS.md § Deploy chain 7).

CREATE TABLE IF NOT EXISTS evidence_archive_runs (
  id BIGSERIAL PRIMARY KEY,
  dataset TEXT NOT NULL,
  day DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'empty', 'failed', 'conflict')),
  object_key TEXT,
  manifest_key TEXT,
  row_count BIGINT NOT NULL DEFAULT 0,
  bytes_gz BIGINT NOT NULL DEFAULT 0,
  bytes_raw BIGINT NOT NULL DEFAULT 0,
  sha256 TEXT,
  min_ts TIMESTAMPTZ,
  max_ts TIMESTAMPTZ,
  detail TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one successful copy per dataset-day. Failed attempts accumulate and do not block a retry.
CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_archive_runs_done
  ON evidence_archive_runs (dataset, day)
  WHERE status IN ('ok', 'empty');

CREATE INDEX IF NOT EXISTS idx_evidence_archive_runs_recent
  ON evidence_archive_runs (finished_at DESC);

ALTER TABLE evidence_archive_runs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE evidence_archive_runs IS
  'Append-only attempt log of the daily R2 evidence archive. A done row (ok|empty) per (dataset, day) is the prune-safety signal.';
