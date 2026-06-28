-- Dedupe mcap_tracker strategy_outcomes — run once on Supabase after deploying sim-track fix.
-- Keeps one row per (strategy_id, token_address, entry_at): latest exit_at, then latest created_at.
-- Matches app dedupe in src/strategies/outcome-dedupe.ts

-- 1) Preview duplicate groups (optional — inspect before delete)
SELECT
  strategy_id,
  token_address,
  entry_at,
  COUNT(*) AS duplicate_count,
  MIN(exit_at) AS earliest_exit,
  MAX(exit_at) AS latest_exit
FROM strategy_outcomes
WHERE domain = 'mcap_tracker'
  AND token_address IS NOT NULL
  AND entry_at IS NOT NULL
GROUP BY strategy_id, token_address, entry_at
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC, latest_exit DESC;

-- 2) Delete duplicate rows (keeps the winner per group)
DELETE FROM strategy_outcomes
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY strategy_id, token_address, entry_at
        ORDER BY exit_at DESC NULLS LAST, created_at DESC
      ) AS rn
    FROM strategy_outcomes
    WHERE domain = 'mcap_tracker'
      AND token_address IS NOT NULL
      AND entry_at IS NOT NULL
  ) ranked
  WHERE rn > 1
);

-- 3) Optional: prevent future duplicate mcap_tracker inserts at DB level
CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_outcomes_mcap_trade_once
  ON strategy_outcomes (strategy_id, token_address, entry_at)
  WHERE domain = 'mcap_tracker'
    AND token_address IS NOT NULL
    AND entry_at IS NOT NULL;

-- 4) Verify no duplicates remain
SELECT
  strategy_id,
  token_address,
  entry_at,
  COUNT(*) AS cnt
FROM strategy_outcomes
WHERE domain = 'mcap_tracker'
  AND token_address IS NOT NULL
  AND entry_at IS NOT NULL
GROUP BY strategy_id, token_address, entry_at
HAVING COUNT(*) > 1;
