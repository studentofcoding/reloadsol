#!/usr/bin/env bash
# Copy the rug-signal validation harness onto flowey-vps and run it inside reloadsol-web.
#
# READ-ONLY by construction: the harness only SELECTs (the shadow log and the market-cap candles).
# It writes no rows and changes no config — arming or enforcing the signal is a separate, deliberate
# env change, never a side effect of running this.
#
# Usage:
#   bash scripts/run-rug-signal-validate-on-vps.sh [days]    # default 3
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VPS_HOST="${VPS_HOST:-flowey-vps}"
DAYS="${1:-3}"
SCRIPT_LOCAL="$ROOT/scripts/rug-signal-validate.mjs"
[[ -f "$SCRIPT_LOCAL" ]] || { echo "missing $SCRIPT_LOCAL"; exit 1; }

ssh_vps() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$VPS_HOST" "$@"; }

echo "VPS=$VPS_HOST days=$DAYS (read-only)"
scp -o BatchMode=yes "$SCRIPT_LOCAL" "$VPS_HOST:/tmp/rug-signal-validate.mjs"
ssh_vps "docker cp /tmp/rug-signal-validate.mjs reloadsol-web:/tmp/rug-signal-validate.mjs"

ssh_vps "docker exec -e NODE_PATH=/app/node_modules reloadsol-web node /tmp/rug-signal-validate.mjs $DAYS"

# Clean up the container copy (root owns it after docker cp).
ssh_vps "docker exec -u root reloadsol-web rm -f /tmp/rug-signal-validate.mjs; rm -f /tmp/rug-signal-validate.mjs" || true
