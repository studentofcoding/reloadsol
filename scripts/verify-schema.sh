#!/usr/bin/env bash
# Verify all app tables exist in public schema.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DATABASE_URL="${1:-}"

if [[ -z "$DATABASE_URL" ]]; then
  [[ -f .env ]] || { echo "[verify-schema] ERROR: Missing .env or DATABASE_URL arg" >&2; exit 1; }
  eval "$(bash scripts/load-env.sh)"
  DATABASE_URL="$(
    PGUSER="${POSTGRES_USER:-postgres}" \
    PGPASSWORD="${POSTGRES_PASSWORD}" \
    PGDATABASE="${POSTGRES_DB:-reloadsol_db}" \
    PGHOST=127.0.0.1 PGPORT=5432 \
    bash scripts/build-database-url.sh
  )"
fi

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
  mcap_social_pattern_24h
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
missing=()

for table in "${TABLES[@]}"; do
  regclass="$(psql "$DATABASE_URL" -tAc "SELECT to_regclass('public.${table}')" 2>/dev/null || echo "")"
  regclass="${regclass// /}"
  if [[ -z "$regclass" || "$regclass" == "" ]]; then
    missing+=("$table")
    fail=1
  fi
done

echo "Schema check: ${#TABLES[@]} tables"
if [[ "$fail" -ne 0 ]]; then
  echo "Missing tables:"
  for t in "${missing[@]}"; do
    echo "  - $t"
  done
  echo "Run: bash scripts/init-local-db.sh" >&2
  exit 1
fi

fn_count="$(psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM pg_proc WHERE proname = 'increment_operation_counts'" 2>/dev/null || echo 0)"
fn_count="${fn_count// /}"
if [[ "$fn_count" == "0" ]]; then
  echo "WARN: function increment_operation_counts missing — re-run init-local-db.sh" >&2
  exit 1
fi

echo "Schema verification passed (${#TABLES[@]} tables + increment_operation_counts)"
