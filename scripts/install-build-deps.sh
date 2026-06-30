#!/usr/bin/env bash
# Minimal devDeps required for `next build` after npm ci --omit=dev
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() {
  echo "[install-build-deps] $*"
}

has_pkg() {
  [[ -d "node_modules/$1" ]]
}

missing=()
for pkg in typescript @types/react @types/react-dom @types/node; do
  has_pkg "$pkg" || missing+=("$pkg")
done

if [[ ${#missing[@]} -eq 0 ]]; then
  log "build deps already present"
  exit 0
fi

log "Installing: ${missing[*]}"
npm install --no-save --no-audit --no-fund --ignore-scripts "${missing[@]}"
