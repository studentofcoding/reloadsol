#!/usr/bin/env bash
# Start Postgres + PgBouncer for production steady-state.
#
# Does NOT publish Postgres to the host. This VPS co-hosts Flowey on 127.0.0.1:5432.
# Cutover-only host bind is docker-compose.migrate.yml → 127.0.0.1:5433:5432.
# Never merge migrate.yml into docker-deploy / docker-up.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d reloadsol-db reloadsol-bouncer
