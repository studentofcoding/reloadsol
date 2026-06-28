#!/usr/bin/env bash
# Rebuild native Node addons required by @solana/web3.js (bigint-buffer).
# macOS + Linux only; exits 0 when build tools are missing (CI/minimal images).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() {
  echo "[rebuild-native-deps] $*"
}

STAMP_FILE="$ROOT/.cache/bigint-native.stamp"

lockfile_hash() {
  if [[ -f package-lock.json ]]; then
    shasum -a 256 package-lock.json 2>/dev/null | awk '{print $1}'
  else
    shasum -a 256 package.json 2>/dev/null | awk '{print $1}'
  fi
}

stamp_matches_lockfile() {
  [[ -f "$STAMP_FILE" ]] || return 1
  [[ "$(cat "$STAMP_FILE" 2>/dev/null)" == "$(lockfile_hash)" ]]
}

write_stamp() {
  mkdir -p "$(dirname "$STAMP_FILE")"
  lockfile_hash > "$STAMP_FILE"
}
  find node_modules -name package.json -path '*/bigint-buffer/package.json' 2>/dev/null \
    | sed 's|/package.json$||' \
    | sort -u
}

find_bigint_native_modules() {
  find node_modules -name 'bigint_buffer.node' -type f 2>/dev/null
}

bigint_bindings_up_to_date() {
  local pkg_dirs native_module
  pkg_dirs="$(find_bigint_package_dirs)"
  if [[ -z "$pkg_dirs" ]]; then
    return 1
  fi
  while IFS= read -r pkg_dir; do
    [[ -n "$pkg_dir" ]] || continue
    native_module="$(find "$pkg_dir" -name 'bigint_buffer.node' -type f 2>/dev/null | head -1)"
    if [[ -z "$native_module" || ! "$native_module" -nt "$pkg_dir/package.json" ]]; then
      return 1
    fi
  done <<< "$pkg_dirs"
  return 0
}

has_bigint_buffer_installed() {
  [[ -n "$(find_bigint_package_dirs)" ]]
}

has_cpp_compiler() {
  command -v g++ >/dev/null 2>&1 || command -v clang++ >/dev/null 2>&1
}

install_hint() {
  case "$(uname -s)" in
    Darwin)
      log "Install Xcode Command Line Tools: xcode-select --install"
      ;;
    Linux)
      if [[ -f /etc/alpine-release ]]; then
        log "Alpine: apk add --no-cache python3 make g++"
      else
        log "Debian/Ubuntu: sudo apt install -y build-essential python3"
      fi
      ;;
    *)
      log "Install python3, make, and a C++ compiler, then run: npm run rebuild:native"
      ;;
  esac
}

if [[ "${SKIP_NATIVE_REBUILD:-}" == "1" ]]; then
  log "SKIP_NATIVE_REBUILD=1 — skipping."
  exit 0
fi

if ! has_bigint_buffer_installed; then
  log "bigint-buffer not installed — skipping."
  exit 0
fi

if stamp_matches_lockfile && bigint_bindings_up_to_date; then
  log "Native bindings already built — skipping."
  exit 0
fi

if stamp_matches_lockfile; then
  log "Native rebuild already completed for this lockfile — skipping."
  exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  log "python3 not found — skipping native rebuild (pure JS fallback will be used)."
  install_hint
  exit 0
fi

if ! command -v make >/dev/null 2>&1; then
  log "make not found — skipping native rebuild (pure JS fallback will be used)."
  install_hint
  exit 0
fi

if ! has_cpp_compiler; then
  log "C++ compiler not found — skipping native rebuild (pure JS fallback will be used)."
  install_hint
  exit 0
fi

log "Rebuilding bigint-buffer native bindings..."
if npm rebuild bigint-buffer; then
  log "bigint-buffer native bindings OK."
else
  log "WARN: bigint-buffer rebuild failed — pure JS fallback will be used."
  install_hint
  exit 0
fi
