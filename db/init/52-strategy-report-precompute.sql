-- Precomputed `consensus` + `capital` sections for GET /api/strategies/reports.
--
-- Both are whole-analysis outputs (a seeded bootstrap over a 30-day window; a 3-day
-- paper-capital sweep) that do not depend on the report's row-level filters, and together
-- they are the majority of its cold-cache DB round trips. They are refreshed on a schedule
-- by the `report_precompute` worker and read back per (chain, domain, sim, tz).
--
-- The report serves the last row even when it is old — this is a measurement, not a live
-- value — and the response carries `precompute.computed_at` so staleness is visible.

CREATE TABLE IF NOT EXISTS strategy_report_precompute (
  key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_strategy_report_precompute_computed
  ON strategy_report_precompute (computed_at DESC);

ALTER TABLE strategy_report_precompute ENABLE ROW LEVEL SECURITY;
