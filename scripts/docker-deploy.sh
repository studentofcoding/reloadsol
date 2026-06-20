#!/usr/bin/env bash
# docker-deploy.sh
# Production deploy for Docker stack (web + cron).
#
# Key idea: build while the old container is still serving traffic.
# Only recreate containers after the new build succeeds (~5–15s swap gap).
#
# Usage:
#   ./scripts/docker-deploy.sh              # pull + build + up
#   ./scripts/docker-deploy.sh --skip-pull    # build + up only (git hook / CI)
#   ./scripts/docker-deploy.sh --clean        # wipe node_modules/.next first
#   ./scripts/docker-deploy.sh --full-down      # old behaviour: down before build
#
# Env:
#   DEPLOY_BRANCH=main
#   WEB_PORT=3000
#   SKIP_BUILD_CHECKS=true

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)
BRANCH="${DEPLOY_BRANCH:-main}"
WEB_PORT="${WEB_PORT:-3000}"
HEALTH_URL="http://127.0.0.1:${WEB_PORT}/api/health"
SKIP_PULL=false
CLEAN=false
FULL_DOWN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-pull|--skip-git-pull)
      SKIP_PULL=true
      shift
      ;;
    --clean)
      CLEAN=true
      shift
      ;;
    --full-down)
      FULL_DOWN=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

wait_for_health() {
  local url="$1"
  local attempts="${2:-60}"
  local delay="${3:-5}"

  log "Waiting for ${url} ..."
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "Health check OK"
      return 0
    fi
    sleep "$delay"
  done

  log "Health check failed after $((attempts * delay))s"
  "${COMPOSE[@]}" logs --tail=80 web || true
  return 1
}

if [[ ! -f .env ]]; then
  log "Missing .env — copy from .env.docker.example and fill secrets."
  exit 1
fi

if [[ "$SKIP_PULL" == false ]]; then
  log "Fetching origin/${BRANCH} ..."
  git fetch origin "$BRANCH"
  # Drop accidental server-side lockfile edits before pull
  git checkout -- package-lock.json 2>/dev/null || true
  git pull origin "$BRANCH"
fi

if [[ "$FULL_DOWN" == true ]]; then
  log "Stopping stack (--full-down) ..."
  "${COMPOSE[@]}" down --remove-orphans
fi

if [[ "$CLEAN" == true ]]; then
  log "Cleaning .next and node_modules (--clean) ..."
  rm -rf .next node_modules
fi

log "Installing dependencies (npm ci) ..."
npm ci

log "Building Next.js on host (old container still running) ..."
export SKIP_BUILD_CHECKS="${SKIP_BUILD_CHECKS:-true}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
npm run build

log "Rebuilding and recreating containers ..."
"${COMPOSE[@]}" up --build -d

wait_for_health "$HEALTH_URL" 60 5

log "Deploy complete"
"${COMPOSE[@]}" ps
