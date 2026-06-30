#!/usr/bin/env bash
set -euo pipefail

# Clone public schema from hosted Supabase → Docker reloadsol-db (direct, not bouncer).
#
# Usage:
#   SOURCE_DATABASE_URL='postgresql://postgres.[ref]:[pass]@db.[ref].supabase.co:5432/postgres' \
#   TARGET_DATABASE_URL='postgresql://postgres:pass@localhost:5432/reloadsol_db' \
#   bash scripts/migrate-from-supabase.sh

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SOURCE_DATABASE_URL="${SOURCE_DATABASE_URL:?set Supabase direct URL (port 5432, not pooler)}"
TARGET_DATABASE_URL="${TARGET_DATABASE_URL:?set reloadsol-db direct URL}"

if ! command -v pgcopydb >/dev/null 2>&1; then
  echo "pgcopydb not found. Install: brew install pgcopydb" >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found" >&2
  exit 1
fi

echo "→ Ensuring extensions on target..."
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/init/00-extensions.sql

echo "→ Cloning public schema (tables + functions + data)..."
pgcopydb clone \
  --source "$SOURCE_DATABASE_URL" \
  --target "$TARGET_DATABASE_URL" \
  --schema public \
  --drop-if-exists \
  --no-owner \
  --no-acl \
  --table-jobs 4 \
  --index-jobs 4

echo "→ Re-applying roles/grants..."
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/init/01-roles.sql

echo "→ Verifying row counts..."
bash scripts/verify-db-clone.sh "$SOURCE_DATABASE_URL" "$TARGET_DATABASE_URL"

echo "✓ Migration complete"
