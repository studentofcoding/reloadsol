#!/usr/bin/env bash
# Daily dev-reputation / RugCheck shadow soak check — runs ON the VPS.
#
# Installed as a host crontab entry so it runs independently of any agent
# session:
#   17 7 * * * cd /home/ubuntu/reloadsol && bash scripts/run-soak-dev-reputation-on-vps.sh >> logs/dev-reputation-soak.log 2>&1
#
# Read-only against trading data. Sends at most one Telegram alert per
# SOAK_NOTIFY_COOLDOWN_DAYS (default 7) when a bucket becomes significant.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p logs

docker cp scripts/soak-dev-reputation.mjs reloadsol-web:/app/soak-dev-reputation.mjs 1>/dev/null
docker exec -w /app reloadsol-web node /app/soak-dev-reputation.mjs
