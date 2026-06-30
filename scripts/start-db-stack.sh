#!/usr/bin/env bash
# Start Postgres + PgBouncer with localhost :5432 bind (migrate overlay).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

docker compose -f docker-compose.yml -f docker-compose.migrate.yml up -d reloadsol-db reloadsol-bouncer
