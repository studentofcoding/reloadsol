-- Two-question Jev gate beside the social FOMO burst open: an "organic surge"
-- proposition and a "candles not rekt" proposition, combined in code.
-- Idempotent: safe to re-run. `noul` stays as min(organic, candles) for dashboards.

ALTER TABLE social_fomo_noul_shadow ADD COLUMN IF NOT EXISTS organic_noul DOUBLE PRECISION;
ALTER TABLE social_fomo_noul_shadow ADD COLUMN IF NOT EXISTS candles_noul DOUBLE PRECISION;
ALTER TABLE social_fomo_noul_shadow ADD COLUMN IF NOT EXISTS answers JSONB;
ALTER TABLE social_fomo_noul_shadow ADD COLUMN IF NOT EXISTS ohlc_n INTEGER;
ALTER TABLE social_fomo_noul_shadow ADD COLUMN IF NOT EXISTS ohlc_source TEXT;

COMMENT ON COLUMN social_fomo_noul_shadow.noul IS
  'min(organic_noul, candles_noul) — retained for dashboards; prefer the per-question columns.';

COMMENT ON COLUMN social_fomo_noul_shadow.answers IS
  '{organic, candles, organic_band, candles_band} — the raw per-question verdicts.';
