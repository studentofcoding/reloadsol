-- Kanban tracking tag: potential → rising.
-- token_mcap_tracking.label, trading_signals.label, and signal_ohlc_labels
-- cards keyed by that tag. Does not touch rug_label (detect snapshots /
-- strategy episodes), dlmm_potential_list membership, or ML v2-potential.

-- Drop any CHECK that still names the old kanban string, then rewrite rows,
-- then install the rising check. Idempotent on a fresh schema that already
-- uses rising.

DO $$
DECLARE
  cname text;
BEGIN
  IF to_regclass('public.token_mcap_tracking') IS NULL THEN
    RETURN;
  END IF;

  FOR cname IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'token_mcap_tracking'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%potential%'
  LOOP
    EXECUTE format('ALTER TABLE token_mcap_tracking DROP CONSTRAINT %I', cname);
  END LOOP;

  UPDATE token_mcap_tracking SET label = 'rising' WHERE label = 'potential';

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'token_mcap_tracking'
      AND con.conname = 'token_mcap_tracking_label_check'
  ) THEN
    ALTER TABLE token_mcap_tracking
      ADD CONSTRAINT token_mcap_tracking_label_check
      CHECK (label IN ('valid', 'traded_live', 'rising', 'rugged', 'watching'));
  END IF;
END $$;

DO $$
DECLARE
  cname text;
BEGIN
  IF to_regclass('public.trading_signals') IS NULL THEN
    RETURN;
  END IF;

  FOR cname IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'trading_signals'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%potential%'
  LOOP
    EXECUTE format('ALTER TABLE trading_signals DROP CONSTRAINT %I', cname);
  END LOOP;

  UPDATE trading_signals SET label = 'rising' WHERE label = 'potential';

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'trading_signals'
      AND con.conname = 'trading_signals_label_check'
  ) THEN
    ALTER TABLE trading_signals
      ADD CONSTRAINT trading_signals_label_check
      CHECK (label IN ('watching', 'rising', 'rugged'));
  END IF;
END $$;

DO $$
DECLARE
  cname text;
BEGIN
  IF to_regclass('public.signal_ohlc_labels') IS NULL THEN
    RETURN;
  END IF;

  FOR cname IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'signal_ohlc_labels'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%potential%'
  LOOP
    EXECUTE format('ALTER TABLE signal_ohlc_labels DROP CONSTRAINT %I', cname);
  END LOOP;

  -- Same mint cannot keep both the legacy card and a rising card.
  DELETE FROM signal_ohlc_labels old_row
  USING signal_ohlc_labels new_row
  WHERE old_row.label = 'potential'
    AND new_row.label = 'rising'
    AND old_row.token_address = new_row.token_address;

  UPDATE signal_ohlc_labels SET label = 'rising' WHERE label = 'potential';

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'signal_ohlc_labels'
      AND con.conname = 'signal_ohlc_labels_label_check'
  ) THEN
    ALTER TABLE signal_ohlc_labels
      ADD CONSTRAINT signal_ohlc_labels_label_check
      CHECK (label IN ('rising', 'rug'));
  END IF;
END $$;
