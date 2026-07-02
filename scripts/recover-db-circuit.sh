#!/usr/bin/env bash
# Clear in-memory DB circuit breaker after schema apply or connection fix.
# Run on server when cron shows "Database circuit open" / HTTP 409 skipped.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { echo "[recover-db-circuit] $*"; }
fail() { log "ERROR: $*"; exit 1; }

[[ -f .env ]] || fail "Missing .env"

eval "$(bash scripts/load-env.sh)"

docker inspect reloadsol-web >/dev/null 2>&1 || fail "reloadsol-web not running — run: bash scripts/deploy-tencent.sh deploy"

log "DATABASE_URL in web container (masked):"
docker exec reloadsol-web node -e \
  "const u=new URL(process.env.DATABASE_URL||''); console.log('postgresql://'+u.username+':***@'+u.hostname+':'+(u.port||5432)+u.pathname)" \
  || fail "Could not read DATABASE_URL from reloadsol-web"

log "Testing Postgres from inside reloadsol-web..."
if ! docker exec reloadsol-web node -e "
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, prepare: false });
p.query('SELECT 1 AS ok')
  .then(r => { console.log('ok=', r.rows[0].ok); return p.end(); })
  .catch(e => { console.error('FAIL:', e.message); process.exit(1); });
"; then
  log "DB test failed"
  log "  If 'wrong password type': recreate bouncer (Postgres 16 + SCRAM needs AUTH_TYPE=scram-sha-256 in docker-compose.yml)"
  log "    docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d reloadsol-bouncer"
  log "  If auth/URL issue: fix DATABASE_URL in .env (user must match POSTGRES_USER; URL-encode @ # : % in password)"
  log "    node -e \"console.log(encodeURIComponent('your-pass'))\""
  log "  Then: docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps web"
  exit 1
fi

log "Restarting reloadsol-web to clear circuit breaker..."
docker restart reloadsol-web
sleep 15

web_port="$(bash scripts/resolve-host-ports.sh web 2>/dev/null || echo "80")"
health="$(curl -sf "http://127.0.0.1:${web_port}/api/health" || true)"
if [[ -z "$health" ]]; then
  fail "Health check unreachable on port ${web_port}"
fi

echo "$health" | head -c 500
echo ""

if grep -q '"circuitOpen":true' <<< "$health" 2>/dev/null; then
  log "WARN: circuit still open — wait 60s or check docker logs reloadsol-web"
elif grep -qE '"status"\s*:\s*"healthy"' <<< "$health"; then
  log "Health OK"
else
  log "WARN: health degraded — check: docker logs reloadsol-web --tail 50"
fi

cron_port="$(bash scripts/resolve-host-ports.sh cron 2>/dev/null || echo "8080")"
log "Cron workers: http://127.0.0.1:${cron_port}/workers"
curl -sf "http://127.0.0.1:${cron_port}/workers" | head -c 800 || true
echo ""
log "Done — re-check Cron service dashboard in ~2 minutes"
