#!/usr/bin/env bash
# docker-deploy.sh
# Production deploy for Docker stack (web + cron + social-ingest).
#
# Key idea: build while the old container is still serving traffic.
# Only rebuild/recreate services that changed (or --web-only / --cron-only / --social-only / --all).
#
# Usage:
#   ./scripts/docker-deploy.sh              # pull + auto scope + up
#   ./scripts/docker-deploy.sh --skip-pull  # auto scope + up only (git hook / CI)
#   ./scripts/docker-deploy.sh --web-only   # web + social-ingest (always-on)
#   ./scripts/docker-deploy.sh --cron-only  # cron only
#   ./scripts/docker-deploy.sh --social-only
#   ./scripts/docker-deploy.sh --all        # force web + cron + social-ingest
#   ./scripts/docker-deploy.sh --clean      # wipe node_modules/.next first
#   ./scripts/docker-deploy.sh --full-down  # stop stack before build
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
SCOPE_MODE="auto"
DEPLOY_WEB=false
DEPLOY_CRON=false
DEPLOY_SOCIAL=false
DETECTED_SCOPE=""

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
    --auto)
      SCOPE_MODE="auto"
      shift
      ;;
    --web-only)
      SCOPE_MODE="manual"
      DEPLOY_WEB=true
      DEPLOY_CRON=false
      DEPLOY_SOCIAL=true
      shift
      ;;
    --cron-only)
      SCOPE_MODE="manual"
      DEPLOY_WEB=false
      DEPLOY_CRON=true
      DEPLOY_SOCIAL=false
      shift
      ;;
    --social-only)
      SCOPE_MODE="manual"
      DEPLOY_WEB=false
      DEPLOY_CRON=false
      DEPLOY_SOCIAL=true
      shift
      ;;
    --all)
      SCOPE_MODE="manual"
      DEPLOY_WEB=true
      DEPLOY_CRON=true
      DEPLOY_SOCIAL=true
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

resolve_scope() {
  if [[ "$SCOPE_MODE" == "manual" ]]; then
    return
  fi
  DETECTED_SCOPE="$(bash scripts/docker-scope.sh detect)"
  log "Auto-detected deploy scope: ${DETECTED_SCOPE}"
  DEPLOY_WEB=false
  DEPLOY_CRON=false
  DEPLOY_SOCIAL=false
  if [[ "$DETECTED_SCOPE" == *web* ]]; then DEPLOY_WEB=true; fi
  if [[ "$DETECTED_SCOPE" == *cron* ]]; then DEPLOY_CRON=true; fi
  if [[ "$DETECTED_SCOPE" == *social* ]]; then DEPLOY_SOCIAL=true; fi
  # social-ingest is always-on when web is redeployed
  if [[ "$DEPLOY_WEB" == true ]]; then DEPLOY_SOCIAL=true; fi
}

should_build_social() {
  [[ "$DEPLOY_SOCIAL" == true ]] || return 1
  if [[ "$SCOPE_MODE" == "manual" ]]; then
    return 0
  fi
  if [[ "$DEPLOY_WEB" == true ]]; then
    return 0
  fi
  if [[ "$DETECTED_SCOPE" == *social* ]]; then
    return 0
  fi
  return 1
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

wait_for_cron_health() {
  local port attempts delay
  port="$(read_env_var CRON_PORT 2>/dev/null || echo "${CRON_PORT:-8080}")"
  attempts="${1:-30}"
  delay="${2:-3}"
  log "Waiting for reloadsol-cron health on port ${port} ..."
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      log "Cron health OK"
      return 0
    fi
    sleep "$delay"
  done
  log "Cron health check failed"
  "${COMPOSE[@]}" logs --tail=40 cron || true
  return 1
}

ensure_social_running() {
  if [[ "$DEPLOY_SOCIAL" != true && "$DEPLOY_WEB" != true ]]; then
    return 0
  fi
  log "Ensuring social-ingest is running ..."
  if ! "${COMPOSE[@]}" up -d social-ingest; then
    log "social-ingest failed to start"
    "${COMPOSE[@]}" logs --tail=40 social-ingest || true
    return 1
  fi
}

check_duplicate_env_port() {
  local key count
  key="$1"
  count="$(grep -cE "^${key}=" .env 2>/dev/null || true)"
  if [[ "$count" -gt 1 ]]; then
    log "ERROR: .env has ${count} ${key}= lines (keep exactly one). Duplicate keys cause wrong port mapping (Cloudflare 521 / cron bind failures)."
    exit 1
  fi
}

verify_compose_port_config() {
  local cron_port_count
  cron_port_count="$("${COMPOSE[@]}" config 2>/dev/null | awk '
    /^  cron:$/ { in_cron=1; next }
    in_cron && /^  [a-zA-Z0-9_-]+:$/ { in_cron=0 }
    in_cron && /published:/ { n++ }
    END { print n+0 }
  ')"
  if [[ "$cron_port_count" -gt 1 ]]; then
    log "ERROR: merged compose defines ${cron_port_count} cron port mappings (expected 1)."
    log "Ensure docker-compose.prod.yml uses 'ports: !override' for cron."
    exit 1
  fi
}

verify_shyft_api_key() {
  local key count
  count="$(grep -cE '^SHYFT_API_KEY=' .env 2>/dev/null || true)"
  if [[ "$count" -gt 1 ]]; then
    log "ERROR: .env has ${count} SHYFT_API_KEY= lines (keep exactly one)."
    exit 1
  fi
  key="$(read_env_var SHYFT_API_KEY 2>/dev/null || true)"
  if [[ -z "$key" || "$key" == "your-shyft-api-key" ]]; then
    log "ERROR: SHYFT_API_KEY missing or still placeholder in .env (https://shyft.to dashboard)."
    log "Wallet poll and /api/shyft/* need a valid key; set RPC_URL with the same api_key."
    exit 1
  fi
}

verify_env_and_compose() {
  check_duplicate_env_port WEB_PORT
  check_duplicate_env_port CRON_PORT
  verify_shyft_api_key
  verify_compose_port_config
}

if [[ ! -f .env ]]; then
  log "Missing .env — copy from .env.docker.example and fill secrets."
  exit 1
fi

WEB_PORT="$(read_env_var WEB_PORT 2>/dev/null || echo "${WEB_PORT:-3000}")"
log "Configured WEB_PORT=${WEB_PORT} (host mapping to container :3000)"
verify_env_and_compose

if [[ "$SKIP_PULL" == false ]]; then
  log "Fetching origin/${BRANCH} ..."
  git fetch origin "$BRANCH"
  git checkout -- package-lock.json 2>/dev/null || true
  git pull origin "$BRANCH"
fi

resolve_scope

if [[ "$DEPLOY_WEB" == false && "$DEPLOY_CRON" == false && "$DEPLOY_SOCIAL" == false ]]; then
  log "Nothing to deploy (empty scope)."
  exit 0
fi

log "Deploy plan: web=${DEPLOY_WEB} cron=${DEPLOY_CRON} social=${DEPLOY_SOCIAL}"

if [[ "$FULL_DOWN" == true ]]; then
  log "Stopping stack (--full-down) ..."
  "${COMPOSE[@]}" down --remove-orphans
fi

if [[ "$CLEAN" == true ]]; then
  log "Cleaning .next and node_modules (--clean) ..."
  rm -rf .next node_modules
fi

if [[ "$DEPLOY_WEB" == true ]]; then
  log "Installing dependencies (npm ci) ..."
  bash scripts/npm-ci-sync.sh

  log "Building Next.js on host (old container still running) ..."
  export SKIP_BUILD_CHECKS="${SKIP_BUILD_CHECKS:-true}"
  export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
  npm run build
  verify_standalone_build

  log "Building web image ..."
  "${COMPOSE[@]}" build web
fi

if [[ "$DEPLOY_CRON" == true ]]; then
  log "Building cron image ..."
  "${COMPOSE[@]}" build cron
fi

if should_build_social; then
  log "Building social-ingest image ..."
  "${COMPOSE[@]}" build social-ingest
fi

UP_SERVICES=()
if [[ "$DEPLOY_WEB" == true ]]; then UP_SERVICES+=(web); fi
if [[ "$DEPLOY_CRON" == true ]]; then UP_SERVICES+=(cron); fi

log "Recreating services: ${UP_SERVICES[*]:-(none)} social=${DEPLOY_SOCIAL} ..."

if [[ "$DEPLOY_WEB" == true && "$DEPLOY_CRON" == false ]]; then
  "${COMPOSE[@]}" up -d --no-deps web
elif [[ "$DEPLOY_CRON" == true && "$DEPLOY_WEB" == false ]]; then
  "${COMPOSE[@]}" up -d --no-deps cron
elif [[ ${#UP_SERVICES[@]} -gt 0 ]]; then
  "${COMPOSE[@]}" up -d "${UP_SERVICES[@]}"
fi

if [[ "$DEPLOY_WEB" == true ]]; then
  WEB_HOST_PORT="$(resolve_web_host_port)"
  HEALTH_URL="http://127.0.0.1:${WEB_HOST_PORT}/api/health"
  log "Host health URL: ${HEALTH_URL}"
  wait_for_health "$HEALTH_URL" 60 5
fi

if [[ "$DEPLOY_CRON" == true ]]; then
  wait_for_cron_health 30 3 || true
fi

if [[ "$DEPLOY_SOCIAL" == true ]]; then
  ensure_social_running
elif [[ "$DEPLOY_WEB" == true ]]; then
  ensure_social_running
fi

log "Deploy complete (web=${DEPLOY_WEB} cron=${DEPLOY_CRON} social=${DEPLOY_SOCIAL})"
"${COMPOSE[@]}" ps
