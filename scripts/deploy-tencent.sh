#!/usr/bin/env bash
# Tencent Linux production bootstrap — Postgres stack + optional Supabase migrate + deploy.
#
# Usage:
#   bash scripts/deploy-tencent.sh setup     # check deps, npm install (registry.npmjs.org)
#   bash scripts/deploy-tencent.sh db        # start reloadsol-db + reloadsol-bouncer (localhost :5432)
#   bash scripts/deploy-tencent.sh migrate   # pgcopydb Supabase → local Postgres (needs SOURCE_DATABASE_URL)
#   bash scripts/deploy-tencent.sh build     # Next.js host build for Dockerfile.web
#   bash scripts/deploy-tencent.sh deploy      # full prod stack (web + cron + social-ingest)
#   bash scripts/deploy-tencent.sh smoke     # curl health endpoints
#   bash scripts/deploy-tencent.sh backup      # pg_dump to ./backups/
#   bash scripts/deploy-tencent.sh all         # setup → db → build → deploy (skip migrate; run migrate separately)
#
# Env (in .env):
#   POSTGRES_PASSWORD, DATABASE_URL, DATABASE_URL_DIRECT
#   SOURCE_DATABASE_URL — only for migrate (Supabase direct :5432, not pooler)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)
COMPOSE_DB=(docker compose -f docker-compose.yml -f docker-compose.migrate.yml)

log() { echo "[deploy-tencent] $*"; }
fail() { log "ERROR: $*"; exit 1; }

ensure_env() {
  if [[ ! -f .env ]]; then
    if [[ -f .env.docker.example ]]; then
      cp .env.docker.example .env
      log "Created .env from .env.docker.example — edit secrets before production."
    else
      fail "Missing .env"
    fi
  fi
  bash scripts/sanitize-env-ports.sh
  # shellcheck disable=SC1091
  set -a && source .env && set +a
  [[ -n "${POSTGRES_PASSWORD:-}" ]] || fail "Set POSTGRES_PASSWORD in .env"
  [[ "${POSTGRES_PASSWORD}" != "change-me" ]] || fail "Replace placeholder POSTGRES_PASSWORD in .env"
}

npm_install_tencent() {
  export PUPPETEER_SKIP_DOWNLOAD="${PUPPETEER_SKIP_DOWNLOAD:-true}"
  export npm_config_fund=false
  export npm_config_audit=false
  export npm_config_jobs=1
  export NPM_CI_OMIT_DEV=1
  export SKIP_NATIVE_REBUILD=1
  bash scripts/npm-ci-sync.sh
  unset SKIP_NATIVE_REBUILD
  bash scripts/rebuild-native-deps.sh || true
}

cmd_setup() {
  ensure_env
  command -v docker >/dev/null 2>&1 || fail "Install Docker: curl -fsSL https://get.docker.com | sh"
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 required"
  command -v node >/dev/null 2>&1 || fail "Install Node.js 20+"
  node -e "const v=process.versions.node.split('.').map(Number); if(v[0]<20) process.exit(1)" \
    || fail "Node >= 20 required (have $(node -v))"
  bash scripts/ensure-swap.sh 2>/dev/null || log "WARN: run sudo bash scripts/ensure-swap.sh if npm ci OOMs"
  npm_install_tencent
  log "Setup OK"
}

cmd_db() {
  ensure_env
  log "Starting Postgres + PgBouncer (DB bound to 127.0.0.1:5432)..."
  bash scripts/start-db-stack.sh
  docker compose -f docker-compose.yml -f docker-compose.migrate.yml ps reloadsol-db reloadsol-bouncer
  log "DB ready. Direct URL for migrate:"
  log "  DATABASE_URL_DIRECT=postgresql://${POSTGRES_USER:-postgres}:****@127.0.0.1:5432/${POSTGRES_DB:-reloadsol_db}"
}

cmd_migrate() {
  ensure_env
  command -v psql >/dev/null 2>&1 || fail "Install psql: sudo apt install -y postgresql-client"
  if ! command -v pgcopydb >/dev/null 2>&1; then
    log "pgcopydb not on PATH — trying Docker image..."
    export USE_PGCOPYDB_DOCKER=1
  fi
  [[ -n "${SOURCE_DATABASE_URL:-}" ]] || fail "Export SOURCE_DATABASE_URL (Supabase direct :5432)"
  export TARGET_DATABASE_URL="${TARGET_DATABASE_URL:-${DATABASE_URL_DIRECT:-}}"
  if [[ -z "$TARGET_DATABASE_URL" ]]; then
    export TARGET_DATABASE_URL="postgresql://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB:-reloadsol_db}"
  fi
  log "Stopping writers during migrate..."
  "${COMPOSE[@]}" stop cron social-ingest 2>/dev/null || true
  bash scripts/migrate-from-supabase.sh
  log "Migrate done. Run: bash scripts/deploy-tencent.sh deploy"
}

cmd_build() {
  ensure_env
  log "Building Next.js on host..."
  SKIP_BUILD_CHECKS=true NODE_OPTIONS=--max-old-space-size=4096 npm run build
  log "Build OK (.next/standalone)"
}

cmd_deploy() {
  ensure_env
  if [[ ! -d .next/standalone ]]; then
    cmd_build
  fi
  log "Deploying production stack..."
  bash scripts/docker-deploy.sh --skip-pull --all
  "${COMPOSE[@]}" ps
  log "Deploy OK — run: bash scripts/deploy-tencent.sh smoke"
}

cmd_smoke() {
  ensure_env
  local port="${WEB_PORT:-3000}"
  local base="http://127.0.0.1:${port}"
  log "Health: ${base}/api/health"
  curl -sf "${base}/api/health" | head -c 500 || fail "web health failed"
  echo ""
  log "DLMM: ${base}/api/dlmm/health"
  curl -sf "${base}/api/dlmm/health" | head -c 800 || fail "dlmm health failed"
  echo ""
  log "Smoke OK"
}

cmd_backup() {
  ensure_env
  mkdir -p backups
  local file="backups/reloadsol_db-$(date +%Y%m%d-%H%M%S).sql"
  log "Writing ${file}..."
  docker exec reloadsol-db pg_dump -U "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-reloadsol_db}" > "$file"
  log "Backup OK ($(wc -c < "$file") bytes)"
}

cmd_all() {
  cmd_setup
  cmd_db
  cmd_build
  log "Skipping migrate — run manually when ready:"
  log "  export SOURCE_DATABASE_URL='postgresql://...supabase direct...'"
  log "  bash scripts/deploy-tencent.sh migrate"
  cmd_deploy
}

usage() {
  sed -n '3,16p' "$0" | sed 's/^# \?//'
  exit 1
}

case "${1:-}" in
  setup)   cmd_setup ;;
  db)      cmd_db ;;
  migrate) cmd_migrate ;;
  build)   cmd_build ;;
  deploy)  cmd_deploy ;;
  smoke)   cmd_smoke ;;
  backup)  cmd_backup ;;
  all)     cmd_all ;;
  -h|--help|help) usage ;;
  *) usage ;;
esac
