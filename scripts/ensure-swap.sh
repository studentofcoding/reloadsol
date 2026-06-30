#!/usr/bin/env bash
# Create a 2G swapfile when the host has no swap (helps npm ci on 3–4GB VPS).
set -euo pipefail

SWAP_SIZE_GB="${SWAP_SIZE_GB:-2}"
SWAP_FILE="${SWAP_FILE:-/swapfile}"

log() {
  echo "[ensure-swap] $*"
}

if ! command -v free >/dev/null 2>&1; then
  log "free not found — skipping swap check"
  exit 0
fi

total_swap_kb="$(free -k | awk '/^Swap:/ {print $2}')"
if [[ "${total_swap_kb:-0}" -gt 0 ]]; then
  log "Swap already present ($(free -h | awk '/^Swap:/ {print $2}'))"
  exit 0
fi

if [[ "$(id -u)" -ne 0 ]]; then
  log "No swap and not root — run: sudo bash scripts/ensure-swap.sh"
  exit 1
fi

if [[ -f "$SWAP_FILE" ]]; then
  log "Enabling existing ${SWAP_FILE} ..."
  chmod 600 "$SWAP_FILE"
  swapon "$SWAP_FILE" 2>/dev/null || true
  if [[ "$(free -k | awk '/^Swap:/ {print $2}')" -gt 0 ]]; then
    log "Swap enabled"
    exit 0
  fi
fi

log "Creating ${SWAP_SIZE_GB}G swap at ${SWAP_FILE} ..."
fallocate -l "${SWAP_SIZE_GB}G" "$SWAP_FILE" 2>/dev/null || dd if=/dev/zero of="$SWAP_FILE" bs=1M count=$((SWAP_SIZE_GB * 1024)) status=progress
chmod 600 "$SWAP_FILE"
mkswap "$SWAP_FILE"
swapon "$SWAP_FILE"

if ! grep -qF "$SWAP_FILE" /etc/fstab 2>/dev/null; then
  echo "${SWAP_FILE} none swap sw 0 0" >> /etc/fstab
fi

log "Swap enabled: $(free -h | awk '/^Swap:/ {print $2}')"
