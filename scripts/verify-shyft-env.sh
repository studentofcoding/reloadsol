#!/usr/bin/env bash
# Verify SHYFT_API_KEY in .env and test api.shyft.to wallet endpoint.
# Run on the server from repo root: bash scripts/verify-shyft-env.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "ERROR: missing .env"
  exit 1
fi

count="$(grep -cE '^SHYFT_API_KEY=' .env 2>/dev/null || true)"
if [[ "$count" -gt 1 ]]; then
  echo "ERROR: .env has ${count} SHYFT_API_KEY= lines (keep exactly one)."
  exit 1
fi

key="$(grep -E '^SHYFT_API_KEY=' .env | tail -1 | cut -d= -f2- | tr -d '"'"' | tr -d '[:space:]')"
if [[ -z "$key" || "$key" == "your-shyft-api-key" ]]; then
  echo "ERROR: SHYFT_API_KEY missing or placeholder — set a real key from https://shyft.to dashboard."
  exit 1
fi

test_wallet="${TEST_WALLET:-3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX}"
url="https://api.shyft.to/sol/v1/wallet/all_tokens?network=mainnet-beta&wallet=${test_wallet}"

echo "Testing Shyft wallet API (key length ${#key}) ..."
http_code="$(curl -sS -o /tmp/shyft-test.json -w '%{http_code}' -H "x-api-key: ${key}" "$url")"
echo "HTTP ${http_code}"
head -c 200 /tmp/shyft-test.json
echo

if [[ "$http_code" == "401" ]]; then
  echo "FAIL: Unauthorized — key is invalid or revoked. Update SHYFT_API_KEY in .env and recreate web:"
  echo "  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate web"
  exit 1
fi

if [[ "$http_code" != "200" ]]; then
  echo "WARN: unexpected status ${http_code}"
  exit 1
fi

echo "OK: Shyft wallet API accepts this key."
