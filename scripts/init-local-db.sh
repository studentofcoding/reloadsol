#!/usr/bin/env bash
# Apply db/init/*.sql to local Postgres (idempotent). Use when volume exists but schema was not applied.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() {
  echo "[init-local-db] $*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

[[ -f .env ]] || fail "Missing .env — run from project root after deploy-tencent.sh db"

eval "$(bash scripts/load-env.sh)"

command -v psql >/dev/null 2>&1 || fail "Install psql: sudo apt install -y postgresql-client"

if ! docker inspect reloadsol-db >/dev/null 2>&1; then
  fail "reloadsol-db not running — run: bash scripts/deploy-tencent.sh db"
fi

if ! docker exec reloadsol-db pg_isready -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-reloadsol_db}" >/dev/null 2>&1; then
  fail "Postgres not ready — check: docker logs reloadsol-db"
fi

DATABASE_URL="$(
  PGUSER="${POSTGRES_USER:-postgres}" \
  PGPASSWORD="${POSTGRES_PASSWORD}" \
  PGDATABASE="${POSTGRES_DB:-reloadsol_db}" \
  PGHOST=127.0.0.1 PGPORT=5432 \
  bash scripts/build-database-url.sh
)"

for f in db/init/00-extensions.sql db/init/01-roles.sql db/init/02-schema.sql; do
  [[ -f "$f" ]] || fail "Missing $f"
  log "Applying $f ..."
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done

log "Schema applied (extensions + roles + tables)"
