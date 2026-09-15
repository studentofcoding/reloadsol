#!/usr/bin/env bash
# Swap check for when a host `next build` is about to run.
# Artifact deploys (valid .next/standalone) should not need this.
# Low-RAM hosts refuse host next build in scripts/docker-deploy.sh unless
# DEPLOY_ALLOW_HOST_BUILD=1 — this script only fails when swap is missing.
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
  log "Need swap on ${total_mb}MB RAM host (swap is 0) before a host next build."
  log "Prefer: bash scripts/ship-standalone-to-vps.sh (no VPS next build)."
  log "Emergency host build: DEPLOY_ALLOW_HOST_BUILD=1 after sudo bash scripts/ensure-swap.sh"
  exit 1
fi

exit 0
