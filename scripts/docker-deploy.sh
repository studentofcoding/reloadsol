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

read_env_var() {
  local key="$1"
  if [[ ! -f .env ]]; then
    return 1
  fi
  grep -E "^${key}=" .env | tail -1 | cut -d= -f2- | tr -d '"'"'"
}

resolve_web_host_port() {
  local from_docker from_env

  from_docker="$(docker port reloadsol-web 3000/tcp 2>/dev/null | head -1 | sed 's/.*://')"
  if [[ -n "$from_docker" ]]; then
    echo "$from_docker"
    return
  fi

  from_env="$(read_env_var WEB_PORT 2>/dev/null || true)"
  if [[ -n "$from_env" ]]; then
    echo "$from_env"
    return
  fi

  echo "${WEB_PORT:-3000}"
}

verify_standalone_build() {
  local missing=false

  for path in .next/standalone/server.js .next/static .next/standalone/.next/required-server-files.json; do
    if [[ ! -e "$path" ]]; then
      log "Build output missing: ${path}"
      missing=true
    fi
  done

  if [[ "$missing" == true ]]; then
    log "Next.js standalone build is incomplete — fix build errors before deploying."
    return 1
  fi

  log "Standalone build verified (.next/standalone + .next/static)"
}

wait_for_health() {
  local url="$1"
  local attempts="${2:-60}"
  local delay="${3:-5}"
  local container="${4:-reloadsol-web}"
  local configured_web_port docker_host_port

  configured_web_port="$(read_env_var WEB_PORT 2>/dev/null || echo "${WEB_PORT:-3000}")"
  docker_host_port="$(docker port "$container" 3000/tcp 2>/dev/null | head -1 | sed 's/.*://' || true)"

  log "Waiting for ${container} to become healthy (host URL: ${url}) ..."
  for ((i = 1; i <= attempts; i++)); do
    local status
    status="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || echo "missing")"

    if [[ "$status" == "healthy" ]]; then
      if curl -fsS "$url" >/dev/null 2>&1; then
        log "Health check OK (${url})"
        return 0
      fi
      log "Container healthy but ${url} not reachable yet — retrying (WEB_PORT=${configured_web_port}, docker port=${docker_host_port:-unknown}) ..."
    elif [[ "$status" == "unhealthy" ]]; then
      log "Container reported unhealthy"
      "${COMPOSE[@]}" logs --tail=80 web || true
      return 1
    elif [[ "$status" == "missing" ]]; then
      log "Container ${container} not found yet ..."
    fi

    sleep "$delay"
  done

  log "Health check failed after $((attempts * delay))s (last status: ${status:-unknown}, WEB_PORT=${configured_web_port}, docker port=${docker_host_port:-unknown}, tried ${url})"
  "${COMPOSE[@]}" logs --tail=80 web || true
  return 1
}

if [[ ! -f .env ]]; then
  log "Missing .env — copy from .env.docker.example and fill secrets."
  exit 1
fi

WEB_PORT="$(read_env_var WEB_PORT 2>/dev/null || echo "${WEB_PORT:-3000}")"
log "Configured WEB_PORT=${WEB_PORT} (host mapping to container :3000)"

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
bash scripts/npm-ci-sync.sh

log "Building Next.js on host (old container still running) ..."
export SKIP_BUILD_CHECKS="${SKIP_BUILD_CHECKS:-true}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
npm run build
verify_standalone_build

log "Rebuilding and recreating containers ..."
"${COMPOSE[@]}" up --build -d --force-recreate

WEB_HOST_PORT="$(resolve_web_host_port)"
HEALTH_URL="http://127.0.0.1:${WEB_HOST_PORT}/api/health"
log "Host health URL: ${HEALTH_URL}"

wait_for_health "$HEALTH_URL" 60 5

log "Deploy complete"
"${COMPOSE[@]}" ps
