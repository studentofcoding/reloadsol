#!/usr/bin/env bash
# Run the exit-contract backfill against production from the reloadsol-web container
# (the DB has no published host port, so the script must run where DATABASE_URL resolves).
#
# Usage:
#   bash scripts/run-backfill-exit-contracts-on-vps.sh            # dry-run (default)
#   APPLY=1 bash scripts/run-backfill-exit-contracts-on-vps.sh    # write
#   EXTRA_ARGS="--strategy-hours=mcap_enter_at_80:12" bash scripts/run-backfill-exit-contracts-on-vps.sh
#
# The override exists for a strategy whose DB config carries no `exit` block. It is never inferred
# from a strategy id — the value has to be stated, because it decides when a live position is closed.
#
# On APPLY the script writes a before-image inside the container; this wrapper copies it back to
# ./backups/ so the rollback does not depend on the container's /tmp surviving.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VPS_HOST="${VPS_HOST:-flowey-vps}"
APPLY="${APPLY:-0}"
EXTRA_ARGS="${EXTRA_ARGS:-}"
SCRIPT_LOCAL="$ROOT/scripts/backfill-exit-contracts-standalone.mjs"
REMOTE="/tmp/backfill-exit-contracts-standalone.mjs"

[[ -f "$SCRIPT_LOCAL" ]] || { echo "missing $SCRIPT_LOCAL"; exit 1; }

ssh_vps() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$VPS_HOST" "$@"; }

echo "VPS=$VPS_HOST mode=$( [[ "$APPLY" == "1" || "$APPLY" == "true" ]] && echo APPLY || echo dry-run )"
scp -o BatchMode=yes "$SCRIPT_LOCAL" "$VPS_HOST:$REMOTE"
ssh_vps "docker cp $REMOTE reloadsol-web:$REMOTE"

ARGS=()
if [[ "$APPLY" == "1" || "$APPLY" == "true" ]]; then ARGS+=(--apply); fi
[[ -n "$EXTRA_ARGS" ]] && ARGS+=($EXTRA_ARGS)

ssh_vps "docker exec -e NODE_PATH=/app/node_modules reloadsol-web node $REMOTE ${ARGS[*]:-}"

if [[ "$APPLY" == "1" || "$APPLY" == "true" ]]; then
  # Pull the before-image out of the container so a rollback survives a container recreate.
  mkdir -p "$ROOT/backups"
  LATEST="$(ssh_vps "docker exec reloadsol-web sh -lc 'ls -1t /tmp/exit-contract-backfill-*.json 2>/dev/null | head -1'")"
  if [[ -n "$LATEST" ]]; then
    scp -o BatchMode=yes "$VPS_HOST:$LATEST" "$ROOT/backups/" 2>/dev/null || {
      # Not reachable directly (it lives inside the container), so stream it out.
      ssh_vps "docker exec reloadsol-web cat $LATEST" > "$ROOT/backups/$(basename "$LATEST")"
    }
    echo "before-image copied to backups/$(basename "$LATEST")"
  else
    echo "WARN: no before-image found in the container"
  fi
fi
