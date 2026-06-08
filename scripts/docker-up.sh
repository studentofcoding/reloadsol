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

bash scripts/docker-install.sh

MODE="${1:-prod}"
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

if [[ "$MODE" == "dev" ]]; then
  echo "Starting reloadSOL in DEV mode (hot reload)..."
  COMPOSE_FILES+=(-f docker-compose.dev.yml)
  docker compose "${COMPOSE_FILES[@]}" up --build
  exit 0
fi

if [[ "$MODE" == "prod-daemon" ]]; then
  echo "Starting reloadSOL in PROD mode (detached)..."
  COMPOSE_FILES+=(-f docker-compose.prod.yml)
  build_next_if_needed
  docker compose "${COMPOSE_FILES[@]}" up --build -d
  exit 0
fi

# Default prod (foreground): build on host, package with Dockerfile.web
echo "Starting reloadSOL in PROD mode..."
build_next_if_needed
docker compose "${COMPOSE_FILES[@]}" up --build
