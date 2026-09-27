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

command -v docker >/dev/null 2>&1 || fail "Install Docker"

if ! docker inspect reloadsol-db >/dev/null 2>&1; then
  fail "reloadsol-db not running — run: bash scripts/deploy-tencent.sh db"
fi

if ! docker exec reloadsol-db pg_isready -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-reloadsol_db}" >/dev/null 2>&1; then
  fail "Postgres not ready — check: docker logs reloadsol-db"
fi

# Apply via docker exec so host 5432 is not required (prod does not publish Postgres;
# migrate overlay is 127.0.0.1:5433 for cutover psql only).
# Apply ALL db/init migrations in order. Each is idempotent (CREATE TABLE IF
# NOT EXISTS / ADD COLUMN IF NOT EXISTS), so re-running on an existing volume is
# safe and backfills any migrations added after the volume was first created
# (the Docker entrypoint only runs init scripts on a fresh data dir).
# A failing file is reported but does NOT abort the run — otherwise one
# non-idempotent migration silently skips every later one. The exit code is
# still nonzero so callers fail the deploy. Guarded by `npm run db:check-migrations`.
failed=()
for f in db/init/*.sql; do
  [[ -f "$f" ]] || fail "Missing $f"
  log "Applying $f ..."
  if ! docker exec -i \
    -e PGPASSWORD="${POSTGRES_PASSWORD}" \
    reloadsol-db \
    psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-reloadsol_db}" -v ON_ERROR_STOP=1 < "$f"; then
    failed+=("$f")
  fi
done

if [[ "${#failed[@]}" -gt 0 ]]; then
  log "ERROR: ${#failed[@]} migration(s) failed (later files were still applied):"
  printf '  [init-local-db] FAILED %s\n' "${failed[@]}" >&2
  exit 1
fi

log "Schema applied (extensions + roles + tables + migrations)"
