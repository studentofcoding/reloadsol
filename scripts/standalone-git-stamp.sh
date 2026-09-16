#!/usr/bin/env bash
# Stamp / check git SHA on Next standalone artifacts so docker-deploy does not
# reuse a stale .next after git pull (ChunkLoadError / React #418).
#
# Stamp files:
#   .next/standalone/.deploy-git-sha
#   .next/static/.deploy-git-sha
#
# Usage:
#   source scripts/standalone-git-stamp.sh
#   stamp_standalone_git_sha
#   standalone_git_sha_matches_head   # exit 0 if match

_stamp_log() {
  if declare -F log >/dev/null 2>&1; then
    log "$@"
  else
    echo "[standalone-git-stamp] $*"
  fi
}

current_git_sha() {
  git rev-parse HEAD 2>/dev/null || true
}

stamp_standalone_git_sha() {
  local sha
  sha="$(current_git_sha)"
  if [[ -z "$sha" ]]; then
    _stamp_log "WARN: no git HEAD — skipping standalone stamp"
    return 0
  fi
  mkdir -p .next/standalone .next/static
  printf '%s\n' "$sha" > .next/standalone/.deploy-git-sha
  printf '%s\n' "$sha" > .next/static/.deploy-git-sha
  _stamp_log "Stamped standalone + static with git ${sha:0:12}"
}

standalone_git_sha_matches_head() {
  local sha quiet="${VERIFY_STANDALONE_QUIET:-}"
  sha="$(current_git_sha)"
  if [[ -z "$sha" ]]; then
    return 0
  fi
  local s_stand s_static
  s_stand="$(cat .next/standalone/.deploy-git-sha 2>/dev/null || true)"
  s_static="$(cat .next/static/.deploy-git-sha 2>/dev/null || true)"
  if [[ -z "$s_stand" || -z "$s_static" ]]; then
    if [[ "$quiet" != "1" ]]; then
      _stamp_log "Standalone git stamp missing — treat as stale (need next build after pull)"
    fi
    return 1
  fi
  if [[ "$s_stand" != "$sha" || "$s_static" != "$sha" ]]; then
    if [[ "$quiet" != "1" ]]; then
      _stamp_log "Standalone git stamp stale (stand=${s_stand:0:12} static=${s_static:0:12} head=${sha:0:12}) — need next build"
    fi
    return 1
  fi
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  cd "$ROOT"
  case "${1:-stamp}" in
    stamp) stamp_standalone_git_sha ;;
    check) standalone_git_sha_matches_head ;;
    *) echo "usage: $0 [stamp|check]"; exit 2 ;;
  esac
fi
