#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

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

build_next_if_needed() {
  if [[ ! -d .next/standalone ]]; then
    echo "→ Building Next.js on host (SKIP_BUILD_CHECKS=true)..."
    SKIP_BUILD_CHECKS=true NODE_OPTIONS=--max-old-space-size=4096 npm run build
    echo "✓ Next.js build complete"
  else
    echo "→ Reusing existing .next/standalone (delete .next to force rebuild)"
  fi
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
