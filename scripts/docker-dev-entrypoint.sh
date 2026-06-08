#!/bin/sh
set -e
cd /app
echo "→ Installing npm dependencies (dev container)..."
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi
echo "✓ Starting Next.js dev server..."
exec npm run dev
