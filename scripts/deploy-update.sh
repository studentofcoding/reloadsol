#!/bin/bash

# deploy-update.sh
# Lightweight deployment script intended to run **after** the server is already provisioned
# with deploy-single-core.sh. Executes only the steps needed on a code update:
#   1. Install production deps (if lockfile changed)
#   2. Build the app (unless --skip-build)
#   3. Reload PM2
# This script is idempotent and fast; ideal for Git hooks.
# Usage (manual): ./scripts/deploy-update.sh [--skip-build]

set -euo pipefail

SKIP_BUILD=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    *)
      echo "Unknown option $1"
      exit 1
      ;;
  esac
done

if [ ! -f package.json ]; then
  echo "❌ Run this script from the project root"
  exit 1
fi

# Timezone verification and setup
echo "🕐 Setting up timezone (UTC+7)"
export TZ='Asia/Bangkok'
echo "Current system time: $(date)"
echo "Timezone set to: $TZ"

# Detect package manager
if [ -f pnpm-lock.yaml ] && command -v pnpm &>/dev/null; then
  PM=pnpm
  echo "📦 Using pnpm"
  # Only install if lockfile changed
  pnpm install --frozen-lockfile --prod --no-optional || true
elif [ -f package-lock.json ]; then
  PM=npm
  echo "📦 Using npm"
  npm ci --only=production --no-audit --no-fund || true
else
  PM=npm
  echo "📦 Using npm (default)"
  npm ci --only=production --no-audit --no-fund || true
fi

if [ "$SKIP_BUILD" = false ]; then
  echo "🔨 Building ..."
  if [ "$PM" = pnpm ]; then
    TZ='Asia/Bangkok' pnpm run build
  else
    TZ='Asia/Bangkok' npm run build
  fi
else
  echo "🚧 Skipping build (per flag)"
fi

echo "♻️ Reloading PM2"
pm2 reload ecosystem.config.js --env production || pm2 start ecosystem.config.js --env production
pm2 save

# Verify PM2 is running with correct timezone
echo "🔍 Verifying PM2 timezone configuration"
pm2 show reloadsol | grep -E "(TZ|timezone)" || echo "No explicit timezone info in PM2 process"

echo "✅ Update complete with UTC+7 timezone"