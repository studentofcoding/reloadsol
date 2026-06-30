#!/usr/bin/env bash
# One-time / idempotent checks before running social-ingest on a production server.
#
# Usage:
#   bash scripts/bootstrap-social-server.sh           # check env + session, seed wallets
#   bash scripts/bootstrap-social-server.sh --check   # checks only, no seed

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECK_ONLY=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=true
fi

log() {
  echo "[bootstrap-social] $*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

read_env_var() {
  local key="$1"
  if [[ ! -f .env ]]; then
    return 1
  fi
  grep -E "^${key}=" .env | tail -1 | cut -d= -f2- | tr -d '"'"'" | tr -d ' '
}

[[ -f .env ]] || fail "Missing .env — copy from .env.docker.example"

missing=()
for key in DATABASE_URL API_ID API_HASH PHONE_NUMBER; do
  val="$(read_env_var "$key" 2>/dev/null || true)"
  if [[ -z "$val" ]]; then
    missing+=("$key")
  fi
done

channel_count=0
for key in GMGN_ID GMGN_TRACKER_ID GMGN_SOLANA_FDV_AND_SMART_MONEY_ID FINDER_TRENDING_ID; do
  val="$(read_env_var "$key" 2>/dev/null || true)"
  if [[ -n "$val" ]]; then
    channel_count=$((channel_count + 1))
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  fail "Missing required .env vars: ${missing[*]}"
fi

if [[ "$channel_count" -eq 0 ]]; then
  fail "No Telegram channel IDs set (GMGN_ID, GMGN_TRACKER_ID, etc.)"
fi

SESSION_NAME="$(read_env_var SOCIAL_SESSION_NAME 2>/dev/null || echo session_search)"
SESSION_DIR="$(read_env_var SESSION_DIR 2>/dev/null || echo social-ingest/sessions)"
SESSION_FILE="${ROOT}/${SESSION_DIR}/${SESSION_NAME}.session"

if [[ ! -f "$SESSION_FILE" ]]; then
  fail "Telethon session missing: ${SESSION_FILE}
Copy from dev (scp) or run interactive login — see social-ingest/README.md"
fi

log "Env OK (${channel_count} channel IDs configured)"
log "Session OK (${SESSION_FILE})"
log "Reminder: ensure db/init schema is applied (automatic on fresh docker compose up)"

if [[ "$CHECK_ONLY" == true ]]; then
  log "Checks passed (--check, skipping wallet seed)"
  exit 0
fi

log "Seeding tracked_wallets from data/tracked-wallets.txt ..."
npm run social:seed-wallets

log "Bootstrap complete. Deploy with: npm run docker:deploy"
