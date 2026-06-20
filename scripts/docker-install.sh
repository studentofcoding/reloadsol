#!/usr/bin/env bash
# Install npm dependencies before Docker build/start.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "→ Installing npm dependencies..."
bash scripts/npm-ci-sync.sh
echo "✓ Dependencies ready"
