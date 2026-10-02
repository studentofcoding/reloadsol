#!/usr/bin/env bash
# Two-pass migration check against a throwaway Postgres.
#
# Pass 1 builds the schema from empty; pass 2 re-applies every db/init/*.sql on
# the now-migrated database. Pass 2 is the regression guard for the
# "early migration not idempotent after later ones" class: e.g. 23 makes
# token_rug_list's unique composite so 02's ON CONFLICT target no longer matches,
# and 15 inserts a 'social' strategy row so 10's domain check is violated.
# Both passes must be clean.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

IMAGE="${MIGCHECK_IMAGE:-postgres:16-alpine}"
DB="${MIGCHECK_DB:-reloadsol_db}"
PGUSER="postgres"
CONTAINER="reloadsol-migcheck-$$"
READY_TIMEOUT_S="${MIGCHECK_READY_TIMEOUT_S:-60}"

log() { echo "[migcheck] $*"; }
fail() { log "ERROR: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "Install Docker"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "Starting throwaway ${IMAGE} (${CONTAINER}) ..."
docker run -d --rm --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=migcheck \
  -e POSTGRES_DB="$DB" \
  "$IMAGE" postgres -c shared_preload_libraries=pg_stat_statements >/dev/null

log "Waiting for Postgres ..."
ready=0
for _ in $(seq 1 "$READY_TIMEOUT_S"); do
  # The image runs a throwaway server during initdb, then restarts the real one.
  # Wait for the init-complete marker before pg_isready, or we can connect
  # during that shutdown window ("the database system is shutting down").
  if docker logs "$CONTAINER" 2>&1 | grep -q "PostgreSQL init process complete" \
    && docker exec "$CONTAINER" pg_isready -U "$PGUSER" -d "$DB" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" == "1" ]] || fail "Postgres not ready after ${READY_TIMEOUT_S}s"

apply_pass() {
  local pass="$1" f out
  for f in db/init/*.sql; do
    [[ -f "$f" ]] || fail "Missing $f"
    if ! out="$(docker exec -i "$CONTAINER" \
        psql -U "$PGUSER" -d "$DB" -v ON_ERROR_STOP=1 -q < "$f" 2>&1)"; then
      log "FAIL (pass ${pass}): ${f}"
      printf '%s\n' "$out" | grep -iE '^ERROR' | head -3 >&2 || printf '%s\n' "$out" | tail -5 >&2
      return 1
    fi
  done
  return 0
}

log "Pass 1/2: applying all db/init/*.sql ..."
apply_pass 1 || fail "migrations failed on a fresh database (pass 1)"

log "Pass 2/2: re-applying (idempotency) ..."
apply_pass 2 || fail "migrations are not idempotent (pass 2 failed)"

assert_sql() {
  local sql="$1" want="$2" desc="$3" got
  got="$(docker exec "$CONTAINER" psql -U "$PGUSER" -d "$DB" -tAc "$sql")"
  got="${got//[[:space:]]/}"
  [[ "$got" == "$want" ]] || fail "${desc}: expected '${want}', got '${got}'"
}

assert_sql "SELECT to_regclass('public.token_info_detect')" \
  "token_info_detect" "ledger table missing"
assert_sql "SELECT count(*) FROM pg_constraint WHERE conname='token_mcap_tracking_label_check' AND pg_get_constraintdef(oid) LIKE '%rising%'" \
  "1" "label check does not allow rising"

log "OK: all db/init/*.sql applied cleanly twice; smoke asserts passed"
