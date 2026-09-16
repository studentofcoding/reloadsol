#!/usr/bin/env bash
# Bring the Docker stack up. Steady-state files only:
#   docker-compose.yml (+ docker-compose.prod.yml for prod-daemon)
# Never merge docker-compose.migrate.yml (cutover-only host bind 127.0.0.1:5433).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/verify-standalone-build.sh
source "$ROOT/scripts/verify-standalone-build.sh"

if [[ ! -f .env ]]; then
  if [[ -f .env.docker.example ]]; then
    echo "Creating .env from .env.docker.example — edit secrets before production use."
    cp .env.docker.example .env
  else
    echo "Missing .env — create one with required variables."
    exit 1
  fi
fi

bash scripts/sanitize-env-ports.sh

bash scripts/docker-install.sh

MODE="${1:-prod}"
SERVICES="${2:-all}"

COMPOSE_FILES=(-f docker-compose.yml)

host_total_ram_mb() {
  if command -v free >/dev/null 2>&1; then
    free -m | awk '/^Mem:/ {print $2}'
  else
    echo "0"
  fi
}

build_next_if_needed() {
  if VERIFY_STANDALONE_QUIET=1 verify_standalone_build; then
    echo "→ Reusing verified .next/standalone + .next/static (skip host next build)"
    return 0
  fi

  local total_mb
  total_mb="$(host_total_ram_mb)"
  if [[ "${total_mb:-0}" -gt 0 && "${total_mb}" -lt 4096 && ! ( "${DEPLOY_ALLOW_HOST_BUILD:-}" == "1" && "${DEPLOY_FORCE_LOW_RAM_BUILD:-}" == "1" ) ]]; then
    echo "ERROR: host RAM ${total_mb}MB < 4096MB — refusing host next build (OOM / SSH lock risk)."
    echo "Ship a Mac/CI standalone: bash scripts/ship-standalone-to-vps.sh"
    echo "Emergency: DEPLOY_ALLOW_HOST_BUILD=1 DEPLOY_FORCE_LOW_RAM_BUILD=1 npm run docker:up"
    echo "Do not use next build --webpack (ioredis dns / node:diagnostics_channel)."
    exit 1
  fi

  local node_opts="${NODE_OPTIONS:-}"
  if [[ -z "$node_opts" ]]; then
    if [[ "${total_mb:-0}" -gt 0 && "${total_mb}" -lt 4096 ]]; then
      node_opts="--max-old-space-size=1536"
    else
      node_opts="--max-old-space-size=2048"
    fi
  fi

  echo "→ Building Next.js on host (SKIP_BUILD_CHECKS=true, NODE_OPTIONS=${node_opts})..."
  SKIP_BUILD_CHECKS=true NODE_OPTIONS="$node_opts" npm run build
  verify_standalone_build
  echo "✓ Next.js build complete"
}

resolve_up_services() {
  case "$SERVICES" in
    web) echo "web" ;;
    cron) echo "cron" ;;
    social) echo "social-ingest" ;;
    all|"") echo "web cron social-ingest" ;;
    *) echo "Unknown service target: $SERVICES (use web, cron, social, or all)" >&2; exit 1 ;;
  esac
}

if [[ "$MODE" == "dev" ]]; then
  echo "Starting reloadSOL in DEV mode (web only, hot reload)..."
  COMPOSE_FILES+=(-f docker-compose.dev.yml)
  docker compose "${COMPOSE_FILES[@]}" up --build web
  exit 0
fi

if [[ "$MODE" == "dev-full" ]]; then
  echo "Starting reloadSOL in DEV mode (web + cron)..."
  COMPOSE_FILES+=(-f docker-compose.dev.yml)
  docker compose "${COMPOSE_FILES[@]}" up --build web cron
  exit 0
fi

UP="$(resolve_up_services)"

if [[ "$MODE" == "prod-daemon" ]]; then
  echo "Starting reloadSOL in PROD mode (detached): ${UP}"
  COMPOSE_FILES+=(-f docker-compose.prod.yml)
  if [[ "$SERVICES" == "all" || "$SERVICES" == "web" || -z "$SERVICES" ]]; then
    build_next_if_needed
  fi
  if [[ "$SERVICES" == "web" ]]; then
    docker compose "${COMPOSE_FILES[@]}" up --build -d --no-deps web
    docker compose "${COMPOSE_FILES[@]}" up -d social-ingest
  elif [[ "$SERVICES" == "cron" ]]; then
    docker compose "${COMPOSE_FILES[@]}" up --build -d cron
  elif [[ "$SERVICES" == "social" ]]; then
    docker compose "${COMPOSE_FILES[@]}" up --build -d social-ingest
  else
    docker compose "${COMPOSE_FILES[@]}" up --build -d web cron social-ingest
  fi
  exit 0
fi

# Default prod (foreground)
echo "Starting reloadSOL in PROD mode: ${UP}"
if [[ "$SERVICES" == "all" || "$SERVICES" == "web" || -z "$SERVICES" ]]; then
  build_next_if_needed
fi

if [[ "$SERVICES" == "web" ]]; then
  docker compose "${COMPOSE_FILES[@]}" up --build web
elif [[ "$SERVICES" == "cron" ]]; then
  docker compose "${COMPOSE_FILES[@]}" up --build cron
elif [[ "$SERVICES" == "social" ]]; then
  docker compose "${COMPOSE_FILES[@]}" up --build social-ingest
else
  docker compose "${COMPOSE_FILES[@]}" up --build web cron social-ingest
fi
