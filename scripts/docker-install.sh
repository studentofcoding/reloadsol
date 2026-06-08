#!/usr/bin/env bash
# Install npm dependencies before Docker build/start.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "→ Installing npm dependencies..."
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
echo "✓ Dependencies ready"
