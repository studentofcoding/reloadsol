#!/bin/sh
set -e
cd /app
echo "→ Installing npm dependencies (dev container)..."
bash scripts/npm-ci-sync.sh
echo "✓ Starting Next.js dev server..."
exec npm run dev
