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
#   NPM_CI_OMIT_DEV=1       → same as --omit=dev
#   NPM_CI_IGNORE_SCRIPTS=1 → pass --ignore-scripts to npm ci

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STAMP_FILE="$ROOT/.cache/npm-ci.stamp"

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

if [[ "${NPM_CI_IGNORE_SCRIPTS:-}" == "1" ]]; then
  NPM_CI_ARGS+=(--ignore-scripts)
fi

lockfile_hash() {
  if [[ -f package-lock.json ]]; then
    shasum -a 256 package-lock.json 2>/dev/null | awk '{print $1}'
  else
    shasum -a 256 package.json 2>/dev/null | awk '{print $1}'
  fi
}

write_npm_ci_stamp() {
  mkdir -p "$(dirname "$STAMP_FILE")"
  lockfile_hash > "$STAMP_FILE"
}

node_modules_up_to_date() {
  [[ "${NPM_CI_OMIT_DEV:-}" == "1" ]] || return 1
  [[ -f "$STAMP_FILE" ]] || return 1
  [[ -f node_modules/.package-lock.json ]] || return 1
  [[ "$(cat "$STAMP_FILE" 2>/dev/null)" == "$(lockfile_hash)" ]]
}

lockfile_out_of_sync() {
  local output="$1"
  grep -qE 'package\.json and package-lock\.json|npm-shrinkwrap\.json are in sync|Missing: .+ from lock file' <<< "$output"
}

log_failure_diagnostics() {
  local logfile="$1"
  local exit_code="${2:-}"
  log "npm ci failed — last 40 lines of log:"
  tail -n 40 "$logfile" >&2 || true
  if command -v free >/dev/null 2>&1; then
    log "Memory (free -h):"
    free -h >&2 || true
  fi
  if [[ "$exit_code" == "137" ]]; then
    log "Exit 137 = process killed (usually OOM). Add swap: sudo bash scripts/ensure-swap.sh"
    log "Kernel OOM log: dmesg | tail -20"
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
  local start_ts end_ts elapsed heartbeat_pid

  start_ts="$(date +%s)"
  log "Running: npm ci ${NPM_CI_ARGS[*]:-}"

  (
    while true; do
      sleep 60
      end_ts="$(date +%s)"
      elapsed=$((end_ts - start_ts))
      if command -v free >/dev/null 2>&1; then
        avail="$(free -m | awk '/^Mem:/ {print "available="$7"MB"}')"
        log "npm ci still running (${elapsed}s) — ${avail}"
      else
        log "npm ci still running (${elapsed}s) ..."
      fi
    done
  ) &
  heartbeat_pid=$!

  set +e
  npm ci --no-audit --no-fund "${NPM_CI_ARGS[@]}" 2>&1 | tee "$logfile"
  local npm_status="${PIPESTATUS[0]}"
  set -e

  kill "$heartbeat_pid" 2>/dev/null || true
  wait "$heartbeat_pid" 2>/dev/null || true

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

if node_modules_up_to_date; then
  log "node_modules up to date — skipping npm ci (lockfile unchanged)"
  exit 0
fi

log "Installing dependencies (npm ci) ..."
LOGFILE="$(mktemp "${TMPDIR:-/tmp}/npm-ci.XXXXXX")"
trap 'rm -f "$LOGFILE"' EXIT

NPM_CI_STATUS=0
if run_npm_ci "$LOGFILE"; then
  write_npm_ci_stamp
  exit 0
fi
NPM_CI_STATUS=$?

if ! lockfile_out_of_sync "$(cat "$LOGFILE")"; then
  log_failure_diagnostics "$LOGFILE" "$NPM_CI_STATUS"
  exit 1
fi

log "package-lock.json is out of sync (e.g. new deps in package.json). Repairing ..."
sync_lockfile

log "Retrying npm ci ..."
if run_npm_ci "$LOGFILE"; then
  write_npm_ci_stamp
  exit 0
fi
NPM_CI_STATUS=$?

log_failure_diagnostics "$LOGFILE" "$NPM_CI_STATUS"
exit 1
