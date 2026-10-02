-- 61 — Idempotency keys for operation tracking.
--
-- Why: `increment_operation_counts` is a blind `swap_count = swap_count + increment` with no nonce and no
-- operation id — `p_timestamp` only sets `last_operation_time`, it is not a dedupe key. So a retried
-- tracking call **double-counts**, and because `token_operations` is an aggregate with no per-operation
-- row, the inflation is invisible afterwards. That blocked retrying the call at all, which matters
-- because `ChunkLoadError` (a deploy landing under an open tab) orphans the request in the browser and
-- the operation is lost.
--
-- With a key, a retry is safe: the first call applies the increment, every repeat is a no-op.
--
-- Additive and idempotent, per this repo's migration convention. Apply BEFORE the code that calls it.

CREATE TABLE IF NOT EXISTS operation_keys (
  operation_key   text PRIMARY KEY,
  wallet_address  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE operation_keys IS
  'One row per applied operation. Presence of the key means the increment already happened.';

CREATE INDEX IF NOT EXISTS operation_keys_created_at_idx
  ON operation_keys (created_at);

/**
 * Apply an operation exactly once.
 *
 * Returns TRUE when this call applied it, FALSE when the key was already seen (safe no-op).
 *
 * The key is inserted FIRST, so the check and the increment are one atomic step: two concurrent calls
 * with the same key cannot both increment — the second blocks on the primary key, then sees 0 rows
 * inserted. And because a plpgsql function runs inside the caller's transaction, a failure in the
 * increment rolls the key back too, so a failed call stays retryable rather than being marked applied.
 */
CREATE OR REPLACE FUNCTION track_operation_once(
  p_operation_key   text,
  p_wallet_address  text,
  p_swap_increment  integer,
  p_close_increment integer,
  p_sol_balance     numeric DEFAULT NULL,
  p_timestamp       timestamptz DEFAULT now()
) RETURNS boolean
LANGUAGE plpgsql
AS $function$
DECLARE
  inserted integer;
BEGIN
  IF p_operation_key IS NULL OR length(trim(p_operation_key)) = 0 THEN
    RAISE EXCEPTION 'operation key is required';
  END IF;

  INSERT INTO operation_keys (operation_key, wallet_address, created_at)
  VALUES (p_operation_key, p_wallet_address, p_timestamp)
  ON CONFLICT (operation_key) DO NOTHING;

  GET DIAGNOSTICS inserted = ROW_COUNT;

  IF inserted = 0 THEN
    RETURN false;   -- already applied: do NOT increment again
  END IF;

  PERFORM increment_operation_counts(
    p_wallet_address,
    p_swap_increment,
    p_close_increment,
    p_sol_balance,
    p_timestamp
  );

  RETURN true;
END;
$function$;
