#!/usr/bin/env bash
# Verify PnL open-price Redis + refresh + publish (Docker Compose).
# Usage: ./scripts/check-open-price-pubsub.sh [MINT]
set -euo pipefail

MINT="${1:-G9j8WWDeJXZdvwQgP82ooDuHmpc3Gy8NCSins71Lpump}"
WEB="${WEB_CONTAINER:-reloadsol-web}"
REDIS="${REDIS_CONTAINER:-reloadsol-redis}"
API_BASE="${API_BASE:-http://127.0.0.1}"

echo "== 1. Web REDIS_URL =="
docker exec "$WEB" printenv REDIS_URL

echo "== 2. Redis PING =="
docker exec "$REDIS" redis-cli PING

echo "== 3. Web health =="
docker exec "$WEB" wget -qO- http://127.0.0.1:3000/api/health
echo

echo "== 4. POST /api/prices/open/refresh =="
RESP=$(curl -s -X POST "${API_BASE}/api/prices/open/refresh" \
  -H 'content-type: application/json' \
  -d "{\"mints\":[\"${MINT}\"]}")
echo "$RESP"
PRICE=$(echo "$RESP" | sed -n "s/.*\"${MINT}\":\([0-9.eE+-]*\).*/\1/p")
if [[ -z "$PRICE" || "$PRICE" == "null" ]]; then
  echo "FAIL: empty prices for mint (oracle/GMGN/Jupiter) — not a Redis URL issue"
  exit 2
fi
echo "OK: price=$PRICE"

echo "== 5. Redis KV (5s TTL — act fast) =="
docker exec "$REDIS" redis-cli KEYS 'prices:open:*'
docker exec "$REDIS" redis-cli GET "prices:open:${MINT}" || true

echo "== 6. Pub/sub smoke (subscribe 3s, refresh once) =="
# Background subscriber dumps one message then exits
docker exec "$REDIS" timeout 4 redis-cli SUBSCRIBE prices:open > /tmp/prices-open-sub.txt 2>&1 &
SUB_PID=$!
sleep 1
curl -s -X POST "${API_BASE}/api/prices/open/refresh" \
  -H 'content-type: application/json' \
  -d "{\"mints\":[\"${MINT}\"]}" >/dev/null
wait "$SUB_PID" || true
if grep -q "$MINT" /tmp/prices-open-sub.txt 2>/dev/null; then
  echo "OK: publish seen on prices:open"
  grep -m1 "$MINT" /tmp/prices-open-sub.txt || true
else
  echo "WARN: no publish in 4s — check web logs for [redis-cache]; KV may still be OK"
  cat /tmp/prices-open-sub.txt 2>/dev/null || true
fi

echo
echo "Done. If price+KV/publish OK but PnL Buy Price is \$0 / 0.0%, that is cost basis (External open), not pub/sub."
