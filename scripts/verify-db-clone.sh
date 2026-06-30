#!/usr/bin/env bash
set -euo pipefail

# Compare row counts for all app tables between source and target.
# Usage: bash scripts/verify-db-clone.sh SOURCE_URL TARGET_URL

SOURCE_URL="${1:?source DATABASE_URL}"
TARGET_URL="${2:?target DATABASE_URL}"

TABLES=(
  token_operations
  trading_records
  trading_signals
  sl_tp_positions
  trending_token_tracker
  trending_token_summary
  trending_token_tracker_dev
  trending_token_summary_dev
  token_mcap_tracking
  mcap_threshold_notifications
  token_ohlc_bars
  dlmm_agent_config
  dlmm_candidates
  dlmm_potential_list
  token_rug_list
  dlmm_positions
  dlmm_lessons
  bot_job_locks
  bot_trade_locks
  bot_trading_state
  strategy_definitions
  strategy_outcomes
  market_regime_tags
  wallet_watchlist
  tracked_wallets
  tracked_wallet_holdings
  social_token_events
  social_token_rollups
)

fail=0

count_table() {
  local url="$1"
  local table="$2"
  psql "$url" -tAc "SELECT COUNT(*)::bigint FROM public.${table}" 2>/dev/null || echo "missing"
}

echo "Table                          Source    Target    Status"
echo "------------------------------ --------- --------- ------"

for table in "${TABLES[@]}"; do
  src=$(count_table "$SOURCE_URL" "$table")
  tgt=$(count_table "$TARGET_URL" "$table")

  if [[ "$src" == "missing" && "$tgt" == "missing" ]]; then
    status="skip"
  elif [[ "$src" == "$tgt" ]]; then
    status="ok"
  else
    status="MISMATCH"
    fail=1
  fi

  printf "%-30s %9s %9s %s\n" "$table" "$src" "$tgt" "$status"
done

echo ""
echo "→ Checking increment_operation_counts function..."
fn_src=$(psql "$SOURCE_URL" -tAc "SELECT COUNT(*) FROM pg_proc WHERE proname = 'increment_operation_counts'" 2>/dev/null || echo 0)
fn_tgt=$(psql "$TARGET_URL" -tAc "SELECT COUNT(*) FROM pg_proc WHERE proname = 'increment_operation_counts'" 2>/dev/null || echo 0)
if [[ "$fn_src" != "$fn_tgt" ]]; then
  echo "Function increment_operation_counts mismatch (source=$fn_src target=$fn_tgt)" >&2
  fail=1
else
  echo "increment_operation_counts: ok"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "Verification FAILED" >&2
  exit 1
fi

echo "Verification passed"
