#!/usr/bin/env bash
# Run the shadow risk correlation (RugCheck + dev reputation) against prod.
# Read-only: no writes, no threshold changes. Safe to re-run.
#
# Usage (from repo root):
#   bash scripts/run-rugcheck-correlation-on-vps.sh
#
# The report is inconclusive below CORR_MIN_N (default 20) per bucket — that is
# the signal to stay in shadow, not to lower a threshold.
set -euo pipefail

VPS_HOST="${VPS_HOST:-flowey-vps}"
VPS_DIR="${VPS_DIR:-/home/ubuntu/reloadsol}"
REMOTE_SCRIPT="/app/rugcheck-correlation.mjs"

if ! ssh -o ConnectTimeout=15 "$VPS_HOST" true 2>/dev/null; then
  echo "ERROR: cannot reach ${VPS_HOST}" >&2
  exit 1
fi

# The script lives in the repo; copy the on-server copy into the container so the
# dependency (pg) resolves against /app/node_modules.
ssh "$VPS_HOST" "test -f '${VPS_DIR}/scripts/rugcheck-correlation.mjs'" \
  || { echo "ERROR: ${VPS_DIR}/scripts/rugcheck-correlation.mjs missing — git pull on the VPS" >&2; exit 1; }

ssh "$VPS_HOST" "docker cp '${VPS_DIR}/scripts/rugcheck-correlation.mjs' reloadsol-web:${REMOTE_SCRIPT}"
ssh "$VPS_HOST" "docker exec -w /app reloadsol-web node ${REMOTE_SCRIPT}"
