#!/usr/bin/env bash
# npm-ci-sync.sh
# Prefer npm ci; when package.json and package-lock.json drift, sync once and retry.
#
# Usage:
#   ./scripts/npm-ci-sync.sh                  # npm ci (all deps)
#   ./scripts/npm-ci-sync.sh --only=production
#   ./scripts/npm-ci-sync.sh --fix-lockfile   # only npm install (update lock file locally)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

die() {
  log "ERROR: $*"
  exit 1
}

[[ -f package.json ]] || die "package.json not found (run from project root)"

FIX_LOCKFILE=false
NPM_CI_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --fix-lockfile)
      FIX_LOCKFILE=true
      ;;
    *)
      NPM_CI_ARGS+=("$arg")
      ;;
  esac
done

lockfile_out_of_sync() {
  local output="$1"
  grep -qE 'package\.json and package-lock\.json|npm-shrinkwrap\.json are in sync|Missing: .+ from lock file' <<< "$output"
}

sync_lockfile() {
  log "Syncing package-lock.json with package.json (npm install) ..."
  if [[ -f package-lock.json ]]; then
    npm install --no-audit --no-fund
  else
    log "No package-lock.json — creating with npm install ..."
    npm install --no-audit --no-fund
  fi
}

if [[ "$FIX_LOCKFILE" == true ]]; then
  sync_lockfile
  log "Lock file updated. Commit package-lock.json before deploying."
  exit 0
fi

log "Installing dependencies (npm ci) ..."
set +e
npm_output="$(npm ci "${NPM_CI_ARGS[@]}" 2>&1)"
npm_status=$?
set -e

if [[ $npm_status -eq 0 ]]; then
  printf '%s\n' "$npm_output"
  bash scripts/rebuild-native-deps.sh
  exit 0
fi

printf '%s\n' "$npm_output" >&2

if ! lockfile_out_of_sync "$npm_output"; then
  exit "$npm_status"
fi

log "package-lock.json is out of sync (e.g. new deps in package.json). Repairing ..."
sync_lockfile

log "Retrying npm ci ..."
npm ci "${NPM_CI_ARGS[@]}"
bash scripts/rebuild-native-deps.sh
