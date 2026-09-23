#!/usr/bin/env bash
# Sol-only OHLC corpus refill for the last N days (default 7).
#
# One phase. When the Sol backfill exits 0 this script does not start an
# EVM / robinhood pass. SOL_ONLY=0 is ignored — EVM stays paused.
#
#   bash scripts/mcap-ohlc-refill-daemon.sh
#   bash scripts/mcap-ohlc-refill-daemon.sh --dry-run
#   bash scripts/mcap-ohlc-refill-daemon.sh --no-evm --since-days=7
#
# Env (also read by the backfill / chart client):
#   SINCE_DAYS=7
#   SOL_ONLY=1                 only mode; EVM is not a second phase
#   MCAP_OHLC_CONCURRENCY=3    workers; HTTP starts still follow RPS
#   SOLANATRACKER_OHLC_RPS=3   shared Solana Tracker OHLC start rate
#   SOLANATRACKER_DATA_API_BASE  default ivory-badger secure host, no API key
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SINCE_DAYS="${SINCE_DAYS:-7}"
DRY=()

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY+=(--dry-run) ;;
    --sol-only|--no-evm) ;;
    --since-days=*) SINCE_DAYS="${arg#*=}" ;;
    -h|--help)
      cat <<'EOF'
Usage: bash scripts/mcap-ohlc-refill-daemon.sh [--dry-run] [--no-evm] [--since-days=7]

Runs scripts/backfill-mcap-labels.ts --sol-only for the recent window.
After Sol exits, EVM is not started.

Env:
  SINCE_DAYS=7                  default 7; 0 = full history (not this ops mode)
  SOL_ONLY=1                    documented lock; 0 does not enable an EVM phase
  MCAP_OHLC_CONCURRENCY=3
  SOLANATRACKER_OHLC_RPS=3
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ "${SOL_ONLY:-1}" == "0" ]]; then
  echo "SOL_ONLY=0 is ignored. EVM refill stays paused; this daemon runs Sol only."
fi

echo "Sol OHLC refill: --sol-only --since-days=${SINCE_DAYS} (EVM phase will not start)"
echo "  MCAP_OHLC_CONCURRENCY=${MCAP_OHLC_CONCURRENCY:-3} SOLANATRACKER_OHLC_RPS=${SOLANATRACKER_OHLC_RPS:-3}"

args=(--sol-only --since-days="${SINCE_DAYS}")
if [[ ${#DRY[@]} -gt 0 ]]; then
  args+=("${DRY[@]}")
fi

set +e
npx tsx scripts/backfill-mcap-labels.ts "${args[@]}"
status=$?
set -e

echo "Sol OHLC refill exited ${status}. EVM phase not started."
exit "${status}"
