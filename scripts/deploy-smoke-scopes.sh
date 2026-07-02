#!/usr/bin/env bash
# Lightweight smoke test for docker-scope.sh path classification.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SCOPE="$ROOT/scripts/docker-scope.sh"

assert_classify() {
  local path="$1"
  local expected="$2"
  local actual
  actual="$("$SCOPE" classify "$path")"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL classify $path: got '$actual', want '$expected'" >&2
    exit 1
  fi
  echo "OK  $path → $expected"
}

assert_classify "db/init/02-schema.sql" "db"
assert_classify "nginx/conf.d/reloadsol.conf" "infra"
assert_classify "redis/redis.conf" "infra"
assert_classify "src/app/page.tsx" "web"
assert_classify "main.go" "cron"
assert_classify "social-ingest/main.go" "social"

echo "deploy-smoke-scopes: all checks passed"
