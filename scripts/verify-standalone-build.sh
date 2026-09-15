#!/usr/bin/env bash
# Verify Next.js standalone output for Dockerfile.web (host or Mac ship).
#
# Usage:
#   bash scripts/verify-standalone-build.sh
#   source scripts/verify-standalone-build.sh && verify_standalone_build
#
# Checks:
#   .next/standalone/server.js
#   .next/static
#   .next/standalone/.next/required-server-files.json
#   onnxruntime native: onnxruntime_binding.node plus libonnxruntime.so* (Linux)
#   or libonnxruntime.dylib* (macOS — Mac ship path; Linux Docker still prefers .so)
#
# Env:
#   VERIFY_STANDALONE_QUIET=1  — suppress missing-file logs (skip-build probe)

_verify_standalone_log() {
  if declare -F log >/dev/null 2>&1; then
    log "$@"
  else
    echo "[verify-standalone-build] $*"
  fi
}

verify_standalone_build() {
  local missing=false
  local path
  local onnx_bin=".next/standalone/node_modules/onnxruntime-node/bin"
  local quiet="${VERIFY_STANDALONE_QUIET:-}"

  for path in \
    .next/standalone/server.js \
    .next/static \
    .next/standalone/.next/required-server-files.json
  do
    if [[ ! -e "$path" ]]; then
      if [[ "$quiet" != "1" ]]; then
        _verify_standalone_log "Build output missing: ${path}"
      fi
      missing=true
    fi
  done

  if [[ "$missing" == true ]]; then
    if [[ "$quiet" != "1" ]]; then
      _verify_standalone_log "Next.js standalone build is incomplete — fix build errors before deploying."
    fi
    return 1
  fi

  if ! find "$onnx_bin" -name 'onnxruntime_binding.node' -print -quit 2>/dev/null | grep -q .; then
    if [[ "$quiet" != "1" ]]; then
      _verify_standalone_log "Build output missing onnxruntime_binding.node — Pattern/entry ML will fail in Docker."
    fi
    return 1
  fi

  if ! find "$onnx_bin" -name 'libonnxruntime.so*' -print -quit 2>/dev/null | grep -q . \
    && ! find "$onnx_bin" -name 'libonnxruntime.dylib*' -print -quit 2>/dev/null | grep -q .; then
    if [[ "$quiet" != "1" ]]; then
      _verify_standalone_log "Build output missing onnxruntime native libs (.so / .dylib) — Pattern/entry ML will fail in Docker."
    fi
    return 1
  fi

  _verify_standalone_log "Standalone build verified (.next/standalone + .next/static + onnxruntime native libs)"
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  cd "$ROOT"
  verify_standalone_build
fi
