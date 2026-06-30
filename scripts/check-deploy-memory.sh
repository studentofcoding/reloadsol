#!/usr/bin/env bash
# Fail when a small-RAM host has no swap (npm ci / next build will OOM).
set -euo pipefail

log() {
  echo "[check-deploy-memory] $*"
}

if ! command -v free >/dev/null 2>&1; then
  exit 0
fi

total_mb="$(free -m | awk '/^Mem:/ {print $2}')"
swap_kb="$(free -k | awk '/^Swap:/ {print $2}')"

if [[ "${total_mb:-0}" -lt 4096 && "${swap_kb:-0}" -eq 0 ]]; then
  log "Need swap on ${total_mb}MB RAM host (swap is 0)."
  log "Run: sudo bash scripts/ensure-swap.sh"
  log "Then retry deploy."
  exit 1
fi

exit 0
