-- Weekly strategy review notes (multi-device via DB)

CREATE TABLE IF NOT EXISTS strategy_review_notes (
  period_key TEXT PRIMARY KEY,
  note TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
