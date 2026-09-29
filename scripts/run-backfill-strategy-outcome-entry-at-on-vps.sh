#!/usr/bin/env bash
# Run the entry_at backfill against production from the reloadsol-web container
# (the DB has no published host port, so the script must run where DATABASE_URL resolves).
#
# Usage:
#   bash scripts/run-backfill-strategy-outcome-entry-at-on-vps.sh                 # dry-run (default)
#   APPLY=1 bash scripts/run-backfill-strategy-outcome-entry-at-on-vps.sh         # write
#   EXTRA_ARGS="--strategy=att_rh --tolerance-seconds=600" bash scripts/run-backfill-strategy-outcome-entry-at-on-vps.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VPS_HOST="${VPS_HOST:-flowey-vps}"
APPLY="${APPLY:-0}"
EXTRA_ARGS="${EXTRA_ARGS:-}"
SCRIPT_LOCAL="$ROOT/scripts/backfill-strategy-outcome-entry-at-standalone.mjs"
REMOTE="/tmp/backfill-strategy-outcome-entry-at-standalone.mjs"

[[ -f "$SCRIPT_LOCAL" ]] || { echo "missing $SCRIPT_LOCAL"; exit 1; }

ssh_vps() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$VPS_HOST" "$@"; }

echo "VPS=$VPS_HOST mode=$( [[ "$APPLY" == "1" || "$APPLY" == "true" ]] && echo APPLY || echo dry-run )"
scp -o BatchMode=yes "$SCRIPT_LOCAL" "$VPS_HOST:$REMOTE"
ssh_vps "docker cp $REMOTE reloadsol-web:$REMOTE"

ARGS=()
if [[ "$APPLY" == "1" || "$APPLY" == "true" ]]; then ARGS+=(--apply); fi
[[ -n "$EXTRA_ARGS" ]] && ARGS+=($EXTRA_ARGS)

ssh_vps "docker exec -e NODE_PATH=/app/node_modules reloadsol-web node $REMOTE ${ARGS[*]:-}"
