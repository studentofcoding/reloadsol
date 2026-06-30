#!/usr/bin/env bash
# Parse .env safely for bash (avoids source .env breaking on special chars in URLs).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${1:-.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  exit 0
fi

node -e "
const fs = require('fs');
const dotenv = require('dotenv');
const parsed = dotenv.parse(fs.readFileSync(process.argv[1], 'utf8'));
for (const [k, v] of Object.entries(parsed)) {
  process.stdout.write('export ' + k + '=' + JSON.stringify(v) + '\n');
}
" "$ENV_FILE"
