#!/usr/bin/env bash
# Copy the rug-signal symbol backfill onto flowey-vps and run it inside reloadsol-web.
#
# DRY RUN unless you pass --apply — it prints what it would change and writes nothing. The script
# itself takes a backup of the exact rows it is about to touch before it updates anything, leaves a
# mint it cannot resolve as NULL rather than guessing, and is idempotent (a second run finds nothing
# left to do).
#
# Usage:
#   bash scripts/run-rug-shadow-symbol-backfill-on-vps.sh            # dry run
#   bash scripts/run-rug-shadow-symbol-backfill-on-vps.sh --apply    # write
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VPS_HOST="${VPS_HOST:-flowey-vps}"
APPLY_FLAG="${1:-}"
SCRIPT_LOCAL="$ROOT/scripts/backfill-rug-shadow-symbols.mjs"
[[ -f "$SCRIPT_LOCAL" ]] || { echo "missing $SCRIPT_LOCAL"; exit 1; }

ssh_vps() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$VPS_HOST" "$@"; }

echo "VPS=$VPS_HOST mode=$([[ "$APPLY_FLAG" == "--apply" ]] && echo APPLY || echo 'dry run')"
scp -o BatchMode=yes "$SCRIPT_LOCAL" "$VPS_HOST:/tmp/backfill-rug-shadow-symbols.mjs"
ssh_vps "docker cp /tmp/backfill-rug-shadow-symbols.mjs reloadsol-web:/tmp/backfill-rug-shadow-symbols.mjs"

ssh_vps "docker exec -e NODE_PATH=/app/node_modules reloadsol-web node /tmp/backfill-rug-shadow-symbols.mjs $APPLY_FLAG"

# Clean up the container copy (root owns it after docker cp).
ssh_vps "docker exec -u root reloadsol-web rm -f /tmp/backfill-rug-shadow-symbols.mjs; rm -f /tmp/backfill-rug-shadow-symbols.mjs" || true
