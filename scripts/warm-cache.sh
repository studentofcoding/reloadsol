#!/usr/bin/env bash
# Warm public GET caches after deploy (nginx edge + app cold start).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="$(bash scripts/resolve-host-ports.sh web)"
BASE="http://127.0.0.1:${PORT}"

ROUTES=(
  "/api/solprice"
  "/api/trending"
  "/api/trending/stats"
  "/api/rpc/health"
)

log() { echo "[warm-cache] $*"; }

failed=0
for route in "${ROUTES[@]}"; do
  url="${BASE}${route}"
  code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 15 "$url" 2>/dev/null || echo "000")"
  log "${route} → HTTP ${code}"
  if [[ "$code" != "200" && "$code" != "304" ]]; then
    failed=$((failed + 1))
  fi
done

if [[ "$failed" -gt 0 ]]; then
  log "WARN: ${failed} route(s) did not return 200/304 (non-fatal)"
fi

exit 0
