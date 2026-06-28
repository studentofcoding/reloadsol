#!/usr/bin/env bash
# Rebuild native Node addons required by @solana/web3.js (bigint-buffer).
# macOS + Linux only; exits 0 when build tools are missing (CI/minimal images).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() {
  echo "[rebuild-native-deps] $*"
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

if [[ ! -d node_modules/bigint-buffer ]]; then
  log "bigint-buffer not installed — skipping."
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
