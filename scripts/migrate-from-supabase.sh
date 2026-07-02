#!/usr/bin/env bash
set -euo pipefail

# Clone public schema from hosted Supabase → Docker reloadsol-db (direct, not bouncer).
#
# Usage:
#   SOURCE_DATABASE_URL='postgresql://postgres.[ref]:[pass]@db.[ref].supabase.co:5432/postgres' \
#   TARGET_DATABASE_URL='postgresql://postgres:pass@127.0.0.1:5432/reloadsol_db' \
#   bash scripts/migrate-from-supabase.sh
#
# Optional: USE_PGCOPYDB_DOCKER=1 runs pgcopydb via container on the compose network.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SOURCE_DATABASE_URL="${SOURCE_DATABASE_URL:?set Supabase direct URL (port 5432, not pooler)}"
TARGET_DATABASE_URL="${TARGET_DATABASE_URL:?set reloadsol-db direct URL}"

bash scripts/validate-database-url.sh "$SOURCE_DATABASE_URL" "SOURCE_DATABASE_URL"
bash scripts/validate-database-url.sh "$TARGET_DATABASE_URL" "TARGET_DATABASE_URL"

if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found. Install: sudo apt install -y postgresql-client" >&2
  exit 1
fi

run_pgcopydb_clone() {
  local target="$TARGET_DATABASE_URL"
  local -a extra=( "$@" )

  if command -v pgcopydb >/dev/null 2>&1; then
    pgcopydb clone --source "$SOURCE_DATABASE_URL" --target "$target" "${extra[@]}"
    return
  fi

  if [[ "${USE_PGCOPYDB_DOCKER:-}" == "1" ]]; then
    local network
    network="$(docker inspect reloadsol-db --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' 2>/dev/null || true)"
    if [[ -z "$network" ]]; then
      network="$(docker network ls --format '{{.Name}}' | grep reloadsol | head -1 || true)"
    fi
    [[ -n "$network" ]] || { echo "Start DB first: bash scripts/deploy-tencent.sh db" >&2; exit 1; }
    target="${target/@127.0.0.1/@reloadsol-db}"
    target="${target/@localhost/@reloadsol-db}"
    docker run --rm \
      --network "$network" \
      ghcr.io/dimitri/pgcopydb:latest \
      pgcopydb clone --source "$SOURCE_DATABASE_URL" --target "$target" "${extra[@]}"
    return
  fi

  echo "pgcopydb not found." >&2
  echo "  Ubuntu/Debian: build from https://github.com/dimitri/pgcopydb" >&2
  echo "  Or: USE_PGCOPYDB_DOCKER=1 bash scripts/migrate-from-supabase.sh" >&2
  exit 1
}

echo "→ Ensuring extensions on target..."
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/init/00-extensions.sql

echo "→ Cloning public schema (tables + functions + data)..."
run_pgcopydb_clone \
  --drop-if-exists \
  --no-owner \
  --no-acl \
  --table-jobs 4 \
  --index-jobs 4 \
  --schema public

echo "→ Re-applying roles/grants..."
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/init/01-roles.sql

echo "→ Verifying row counts..."
bash scripts/verify-db-clone.sh "$SOURCE_DATABASE_URL" "$TARGET_DATABASE_URL"

echo "✓ Migration complete"
