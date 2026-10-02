-- 62 — Stop writing an unknown SOL balance as `0`.
--
-- `increment_operation_counts` (02-schema.sql) inserts
--
--     COALESCE(p_sol_balance, 0),
--
-- so when a caller passes no balance the row records **0** — an unmeasured value wearing the clothes of a
-- measurement. Measured 2026-10-02: `sol_balance = 0` for the trading wallet while the wallet actually
-- held 0.046 SOL. Nothing could tell that apart from a genuinely empty wallet.
--
-- The UPDATE branch already had the right instinct (`WHEN p_sol_balance IS NOT NULL`) — it leaves the
-- stored value alone rather than overwriting it with nothing. Only the INSERT coerced. This makes the
-- two agree: an unknown balance is NULL, and every read path must treat NULL as "not known", never zero.
--
-- Existing rows are deliberately NOT rewritten. A stored 0 could be a real empty wallet or an unknown
-- balance, and the two are indistinguishable after the fact — inventing a NULL (or a value) for them
-- would be fabricating. They keep the value they have; new writes are correct from here.
--
-- The column itself also had to change: `sol_balance` carried a NOT NULL constraint, so writing an
-- honestly-unknown NULL was rejected outright. Without this the function would fail EVERY tracking call
-- that omits a balance — a worse bug than the one being fixed. DROP NOT NULL is re-runnable.

ALTER TABLE token_operations
  ALTER COLUMN sol_balance DROP NOT NULL;

-- Additive and idempotent (CREATE OR REPLACE + DROP NOT NULL), per this repo's migration convention.

CREATE OR REPLACE FUNCTION public.increment_operation_counts(
  p_wallet_address text,
  p_swap_increment integer,
  p_close_increment integer,
  p_sol_balance numeric DEFAULT NULL,
  p_timestamp timestamp with time zone DEFAULT now()
) RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO token_operations (
    wallet_address,
    swap_count,
    close_count,
    last_operation_time,
    sol_balance,
    last_balance_update
  ) VALUES (
    p_wallet_address,
    p_swap_increment,
    p_close_increment,
    p_timestamp,
    -- NULL stays NULL: "we did not measure it" is not "it is zero".
    p_sol_balance,
    CASE WHEN p_sol_balance IS NOT NULL THEN p_timestamp ELSE NULL END
  )
  ON CONFLICT (wallet_address)
  DO UPDATE SET
    swap_count = COALESCE(token_operations.swap_count, 0) + p_swap_increment,
    close_count = COALESCE(token_operations.close_count, 0) + p_close_increment,
    last_operation_time = p_timestamp,
    sol_balance = CASE
      WHEN p_sol_balance IS NOT NULL THEN p_sol_balance
      ELSE token_operations.sol_balance
    END,
    last_balance_update = CASE
      WHEN p_sol_balance IS NOT NULL THEN p_timestamp
      ELSE token_operations.last_balance_update
    END;
END;
$function$;
