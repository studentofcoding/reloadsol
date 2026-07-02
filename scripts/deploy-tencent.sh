#!/usr/bin/env bash
# Tencent Linux production bootstrap — Postgres stack + optional Supabase migrate + deploy.
#
# Usage:
#   bash scripts/deploy-tencent.sh setup     # check deps, npm install (registry.npmjs.org)
#   bash scripts/deploy-tencent.sh db        # start reloadsol-db + reloadsol-bouncer (localhost :5432)
#   bash scripts/deploy-tencent.sh schema    # apply db/init/*.sql (no Supabase; idempotent)
#   bash scripts/deploy-tencent.sh migrate   # optional pgcopydb from Supabase (needs SOURCE_DATABASE_URL)
#   bash scripts/deploy-tencent.sh build     # Next.js host build for Dockerfile.web
#   bash scripts/deploy-tencent.sh deploy      # full prod stack (web + cron + social-ingest)
#   bash scripts/deploy-tencent.sh smoke     # infra health (OK pre-migrate)
#   bash scripts/deploy-tencent.sh smoke --strict  # require DB + DLMM healthy
#   bash scripts/deploy-tencent.sh backup      # pg_dump to ./backups/
#   bash scripts/deploy-tencent.sh all         # setup → db → schema → build → deploy
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

SMOKE_STRICT=false

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
  eval "$(bash scripts/load-env.sh)"
  [[ -n "${POSTGRES_PASSWORD:-}" ]] || fail "Set POSTGRES_PASSWORD in .env"
  [[ "${POSTGRES_PASSWORD}" != "change-me" ]] || fail "Replace placeholder POSTGRES_PASSWORD in .env"
}

npm_install_tencent() {
  bash scripts/check-deploy-memory.sh
  export PUPPETEER_SKIP_DOWNLOAD="${PUPPETEER_SKIP_DOWNLOAD:-true}"
  export npm_config_fund=false
  export npm_config_audit=false
  export npm_config_jobs=1
  export NPM_CI_OMIT_DEV=1
  export NPM_CI_IGNORE_SCRIPTS=1
  export SKIP_NATIVE_REBUILD=1
  bash scripts/npm-ci-sync.sh
  unset SKIP_NATIVE_REBUILD NPM_CI_IGNORE_SCRIPTS
  bash scripts/rebuild-native-deps.sh || true
  bash scripts/install-build-deps.sh
}

build_node_options() {
  if [[ -n "${NODE_OPTIONS:-}" ]]; then
    echo "$NODE_OPTIONS"
    return
  fi
  local total_mb=0
  if command -v free >/dev/null 2>&1; then
    total_mb="$(free -m | awk '/^Mem:/ {print $2}')"
  fi
  if [[ "${total_mb:-0}" -lt 4096 ]]; then
    echo "--max-old-space-size=1536"
  else
    echo "--max-old-space-size=4096"
  fi
}

cmd_setup() {
  ensure_env
  command -v docker >/dev/null 2>&1 || fail "Install Docker: curl -fsSL https://get.docker.com | sh"
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 required"
  command -v node >/dev/null 2>&1 || fail "Install Node.js 20+"
  node -e "const v=process.versions.node.split('.').map(Number); if(v[0]<20) process.exit(1)" \
    || fail "Node >= 20 required (have $(node -v))"
  bash scripts/ensure-swap.sh 2>/dev/null || true
  npm_install_tencent
  log "Setup OK"
}

cmd_db() {
  ensure_env
  log "Starting Postgres + PgBouncer (DB bound to 127.0.0.1:5432)..."
  bash scripts/start-db-stack.sh
  docker compose -f docker-compose.yml -f docker-compose.migrate.yml ps reloadsol-db reloadsol-bouncer
  log "DB ready. Apply schema: bash scripts/deploy-tencent.sh schema"
  log "  Direct URL: postgresql://${POSTGRES_USER:-postgres}:****@127.0.0.1:5432/${POSTGRES_DB:-reloadsol_db}"
}

cmd_schema() {
  ensure_env
  bash scripts/init-local-db.sh
  bash scripts/verify-schema.sh
  if docker inspect reloadsol-web >/dev/null 2>&1; then
    docker restart reloadsol-web 2>/dev/null || true
    log "Restarted reloadsol-web to clear DB circuit breaker"
  fi
  log "Schema OK — run: bash scripts/deploy-tencent.sh deploy && bash scripts/deploy-tencent.sh smoke --strict"
}

cmd_migrate() {
  ensure_env
  command -v psql >/dev/null 2>&1 || fail "Install psql: sudo apt install -y postgresql-client"
  if ! command -v pgcopydb >/dev/null 2>&1; then
    log "pgcopydb not on PATH — trying Docker image..."
    export USE_PGCOPYDB_DOCKER=1
  fi
  [[ -n "${SOURCE_DATABASE_URL:-}" ]] || fail "Export SOURCE_DATABASE_URL (Supabase direct :5432)"
  bash scripts/validate-database-url.sh "$SOURCE_DATABASE_URL" "SOURCE_DATABASE_URL" \
    || fail "Fix SOURCE_DATABASE_URL — see Supabase Dashboard → Connect → Direct connection"
  # Always build local target from .env (URL-encoded password; ignore pre-exported TARGET)
  export TARGET_DATABASE_URL="$(
    PGUSER="${POSTGRES_USER:-postgres}" \
    PGPASSWORD="${POSTGRES_PASSWORD}" \
    PGDATABASE="${POSTGRES_DB:-reloadsol_db}" \
    PGHOST=127.0.0.1 PGPORT=5432 \
    bash scripts/build-database-url.sh
  )"
  bash scripts/validate-database-url.sh "$TARGET_DATABASE_URL" "TARGET_DATABASE_URL"
  log "Target: postgresql://${POSTGRES_USER:-postgres}:****@127.0.0.1:5432/${POSTGRES_DB:-reloadsol_db}"
  log "Stopping writers during migrate..."
  "${COMPOSE[@]}" stop cron social-ingest 2>/dev/null || true
  bash scripts/migrate-from-supabase.sh
  log "Migrate done. Run: bash scripts/deploy-tencent.sh deploy"
}

cmd_build() {
  ensure_env
  bash scripts/check-deploy-memory.sh
  bash scripts/install-build-deps.sh
  log "Building Next.js on host..."
  SKIP_BUILD_CHECKS=true NODE_OPTIONS="$(build_node_options)" npm run build
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
  local web_port cron_port base web_json dlmm_code dlmm_body

  if docker inspect reloadsol-web >/dev/null 2>&1; then
    log "Web DATABASE_URL (masked):"
    docker exec reloadsol-web node -e \
      "console.log(process.env.DATABASE_URL?.replace(/:([^:@/]+)@/, ':***@') || 'unset')" 2>/dev/null || true
  fi
  if docker inspect reloadsol-bouncer >/dev/null 2>&1; then
    if docker exec reloadsol-bouncer pg_isready -h reloadsol-db -p 5432 >/dev/null 2>&1; then
      log "PgBouncer → Postgres: OK"
    else
      log "WARN: pg_isready via bouncer failed"
    fi
  fi

  web_port="$(bash scripts/resolve-host-ports.sh web)"
  cron_port="$(bash scripts/resolve-host-ports.sh cron)"
  base="http://127.0.0.1:${web_port}"

  log "Health: ${base}/api/health"
  web_json="$(curl -s "${base}/api/health" || true)"
  if [[ -z "$web_json" ]]; then
    fail "web health unreachable"
  fi
  if grep -q 'circuit open' <<< "$web_json"; then
    log "WARN: DB circuit open — restarting reloadsol-web and retrying..."
    docker restart reloadsol-web 2>/dev/null || true
    sleep 15
    web_json="$(curl -s "${base}/api/health" || true)"
  fi
  echo "$web_json" | head -c 500
  echo ""

  if [[ "$SMOKE_STRICT" == true ]]; then
    grep -qE '"status"\s*:\s*"healthy"' <<< "$web_json" || fail "web not healthy (pre-migrate? run smoke without --strict)"
  elif ! grep -qE '"status"\s*:\s*"(healthy|degraded)"' <<< "$web_json"; then
    fail "web health unexpected response"
  fi

  log "DLMM: ${base}/api/dlmm/health"
  dlmm_code="$(curl -s -o /tmp/reloadsol-dlmm-smoke.json -w "%{http_code}" "${base}/api/dlmm/health" || echo "000")"
  dlmm_body="$(cat /tmp/reloadsol-dlmm-smoke.json 2>/dev/null || true)"
  if [[ "$dlmm_code" == "503" ]]; then
    echo "$dlmm_body" | head -c 800
    echo ""
    if [[ "$SMOKE_STRICT" == true ]]; then
      fail "dlmm health failed (503) — run: bash scripts/deploy-tencent.sh schema"
    fi
    log "WARN: DLMM 503 — schema not ready. Run: bash scripts/deploy-tencent.sh schema"
  elif [[ "$dlmm_code" != "200" ]]; then
    echo "$dlmm_body" | head -c 800
    fail "dlmm health failed (HTTP ${dlmm_code})"
  else
    echo "$dlmm_body" | head -c 800
    echo ""
  fi

  log "Cron: http://127.0.0.1:${cron_port}/health"
  curl -sf "http://127.0.0.1:${cron_port}/health" | head -c 500 || fail "cron health failed"
  echo ""

  if [[ "$SMOKE_STRICT" == true ]]; then
    log "Smoke OK (strict)"
  else
    log "Smoke OK (infra — use 'smoke --strict' after schema)"
  fi
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
  cmd_schema
  cmd_build
  cmd_deploy
  log "Run: bash scripts/deploy-tencent.sh smoke --strict"
}

usage() {
  sed -n '3,16p' "$0" | sed 's/^# \?//'
  exit 1
}

case "${1:-}" in
  setup)   cmd_setup ;;
  db)      cmd_db ;;
  schema|init-schema) cmd_schema ;;
  migrate) cmd_migrate ;;
  build)   cmd_build ;;
  deploy)  cmd_deploy ;;
  smoke)
    [[ "${2:-}" == "--strict" ]] && SMOKE_STRICT=true
    cmd_smoke
    ;;
  backup)  cmd_backup ;;
  all)     cmd_all ;;
  -h|--help|help) usage ;;
  *) usage ;;
esac
