#!/usr/bin/env bash
# npm-ci-sync.sh
# Prefer npm ci; when package.json and package-lock.json drift, sync once and retry.
#
# Usage:
#   ./scripts/npm-ci-sync.sh                  # npm ci (all deps)
#   ./scripts/npm-ci-sync.sh --omit=dev       # production deploy (skip devDependencies)
#   ./scripts/npm-ci-sync.sh --only=production
#   ./scripts/npm-ci-sync.sh --fix-lockfile   # only npm install (update lock file locally)
#
# Env:
#   NPM_CI_OMIT_DEV=1  → same as --omit=dev

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

if [[ "${NPM_CI_OMIT_DEV:-}" == "1" ]]; then
  NPM_CI_ARGS+=(--omit=dev)
fi

lockfile_out_of_sync() {
  local output="$1"
  grep -qE 'package\.json and package-lock\.json|npm-shrinkwrap\.json are in sync|Missing: .+ from lock file' <<< "$output"
}

log_failure_diagnostics() {
  local logfile="$1"
  log "npm ci failed — last 40 lines of log:"
  tail -n 40 "$logfile" >&2 || true
  if command -v free >/dev/null 2>&1; then
    log "Memory (free -h):"
    free -h >&2 || true
  fi
}

sync_lockfile() {
  log "Syncing package-lock.json with package.json (npm install) ..."
  if [[ -f package-lock.json ]]; then
    npm install --no-audit --no-fund "${NPM_CI_ARGS[@]}"
  else
    log "No package-lock.json — creating with npm install ..."
    npm install --no-audit --no-fund "${NPM_CI_ARGS[@]}"
  fi
}

run_npm_ci() {
  local logfile="$1"
  local start_ts end_ts elapsed

  start_ts="$(date +%s)"
  log "Running: npm ci ${NPM_CI_ARGS[*]:-}"
  set +e
  npm ci --no-audit --no-fund "${NPM_CI_ARGS[@]}" 2>&1 | tee "$logfile"
  local npm_status="${PIPESTATUS[0]}"
  set -e
  end_ts="$(date +%s)"
  elapsed=$((end_ts - start_ts))
  log "npm ci finished in ${elapsed}s (exit ${npm_status})"
  return "$npm_status"
}

if [[ "$FIX_LOCKFILE" == true ]]; then
  sync_lockfile
  log "Lock file updated. Commit package-lock.json before deploying."
  exit 0
fi

log "Installing dependencies (npm ci) ..."
LOGFILE="$(mktemp "${TMPDIR:-/tmp}/npm-ci.XXXXXX")"
trap 'rm -f "$LOGFILE"' EXIT

if run_npm_ci "$LOGFILE"; then
  exit 0
fi

if ! lockfile_out_of_sync "$(cat "$LOGFILE")"; then
  log_failure_diagnostics "$LOGFILE"
  exit 1
fi

log "package-lock.json is out of sync (e.g. new deps in package.json). Repairing ..."
sync_lockfile

log "Retrying npm ci ..."
if run_npm_ci "$LOGFILE"; then
  exit 0
fi

log_failure_diagnostics "$LOGFILE"
exit 1
