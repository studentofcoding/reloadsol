#!/usr/bin/env bash
# Copy standalone replay onto flowey-vps and run inside reloadsol-web (paper/sim only).
# Usage:
#   DRY_RUN=1 bash scripts/run-replay-mcap-first-seen-14d-on-vps.sh   # default dry-run
#   DRY_RUN=0 bash scripts/run-replay-mcap-first-seen-14d-on-vps.sh   # persist
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VPS_HOST="${VPS_HOST:-flowey-vps}"
DRY_RUN="${DRY_RUN:-1}"
SCRIPT_LOCAL="$ROOT/scripts/replay-mcap-first-seen-14d-standalone.mjs"
[[ -f "$SCRIPT_LOCAL" ]] || { echo "missing $SCRIPT_LOCAL"; exit 1; }

ssh_vps() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$VPS_HOST" "$@"; }

echo "VPS=$VPS_HOST dry_run=$DRY_RUN"
scp -o BatchMode=yes "$SCRIPT_LOCAL" "$VPS_HOST:/tmp/replay-mcap-first-seen-14d-standalone.mjs"
ssh_vps "docker cp /tmp/replay-mcap-first-seen-14d-standalone.mjs reloadsol-web:/tmp/replay-mcap-first-seen-14d-standalone.mjs"

ARGS=()
if [[ "$DRY_RUN" == "1" || "$DRY_RUN" == "true" ]]; then ARGS+=(--dry-run); fi

ssh_vps "docker exec -e NODE_PATH=/app/node_modules reloadsol-web node /tmp/replay-mcap-first-seen-14d-standalone.mjs ${ARGS[*]:-}"

echo "Done. Optional ML label backfill:"
echo "  curl -X POST \"https://reloadsol.app/api/strategies/ml/backfill-labels?domain=mcap_tracker&key=\$TRENDING_TRACKER_SECRET\""
echo "Smoke: curl -sS \"https://reloadsol.app/api/strategies/outcomes?tokenAddress=BIDDY&domain=mcap_tracker\""
