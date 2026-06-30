#!/usr/bin/env bash
# Remove blank port vars from .env — empty WEB_PORT= breaks Tencent Docker Compose interpolation.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${1:-.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  exit 0
fi

log() {
  echo "[sanitize-env-ports] $*"
}

removed=false
for key in WEB_PORT CRON_PORT POSTGRES_HOST_PORT; do
  if grep -qE "^${key}=$" "$ENV_FILE" 2>/dev/null; then
    sed -i.bak "/^${key}=$/d" "$ENV_FILE"
    rm -f "${ENV_FILE}.bak"
    log "Removed blank ${key}= from ${ENV_FILE}"
    removed=true
  fi
done

if [[ "$removed" == false ]]; then
  log "No blank port vars in ${ENV_FILE}"
fi
