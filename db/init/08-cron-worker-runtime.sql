-- Cron worker runtime (survives cron container rebuilds)
CREATE TABLE IF NOT EXISTS cron_worker_runtime (
  worker_id TEXT PRIMARY KEY,
  last_started_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error_msg TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cron_worker_runtime_updated
  ON cron_worker_runtime(updated_at DESC);
