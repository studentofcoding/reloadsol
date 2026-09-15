#!/usr/bin/env bash
# ship-standalone-to-vps.sh
#
# Run on the build machine (Mac / CI), not on the ~3.6Gi VPS.
# Turbopack `next build` locally, rsync `.next/standalone` + `.next/static`,
# then rebuild only the web image on the VPS (no host `next build` there).
#
# Usage (from repo root):
#   bash scripts/ship-standalone-to-vps.sh
#   VPS_HOST=flowey-vps VPS_DIR=/root/reloadsol bash scripts/ship-standalone-to-vps.sh
#   SKIP_LOCAL_BUILD=1 bash scripts/ship-standalone-to-vps.sh   # reuse verified .next
#
# Env:
#   VPS_HOST          SSH host (default: flowey-vps)
#   VPS_DIR           Remote app path. If unset, probed from common locations
#                     that contain docker-compose.yml + Dockerfile.web.
#   SKIP_LOCAL_BUILD=1  Skip `npm run build` when local standalone already verifies
#   SKIP_SMOKE=1      Skip /api/health curl after remote up
#   SMOKE_URL         Public health URL (default: https://reloadsol.app/api/health)
#   SKIP_BUILD_CHECKS  Passed through to next build (default: true)
#
# Remote compose matches production: docker-compose.yml + docker-compose.prod.yml.
# Does not merge docker-compose.migrate.yml (cutover only; host 5433).
#
# Webpack is not used: ioredis (dns) / node:diagnostics_channel break the client graph.
# onnxruntime native libs are platform-specific; verify accepts .so or .dylib so a
# Mac ship is not blocked. Linux Pattern ML still wants linux-x64 .so in the image.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/verify-standalone-build.sh
source "$ROOT/scripts/verify-standalone-build.sh"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ship-standalone] $*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

VPS_HOST="${VPS_HOST:-flowey-vps}"
SKIP_LOCAL_BUILD="${SKIP_LOCAL_BUILD:-0}"
SKIP_SMOKE="${SKIP_SMOKE:-0}"
SMOKE_URL="${SMOKE_URL:-https://reloadsol.app/api/health}"
REMOTE_COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

detect_vps_dir() {
  if [[ -n "${VPS_DIR:-}" ]]; then
    printf '%s\n' "$VPS_DIR"
    return 0
  fi

  log "VPS_DIR unset — probing ${VPS_HOST} for docker-compose.yml + Dockerfile.web ..."
  local found
  found="$(ssh -o BatchMode=yes "$VPS_HOST" 'bash -s' <<'EOS' || true
for d in \
  /opt/reloadsol \
  /root/reloadsol \
  /home/ubuntu/reloadsol \
  /var/www/reloadsol \
  "$HOME/reloadsol" \
  "$HOME/apps/reloadsol" \
  "$HOME/src/reloadsol"; do
  if [[ -f "$d/docker-compose.yml" && -f "$d/Dockerfile.web" ]]; then
    echo "$d"
    exit 0
  fi
done
exit 1
EOS
)"
  [[ -n "$found" ]] || fail "Could not detect remote app dir on ${VPS_HOST}. Set VPS_DIR=/path/to/reloadsol"
  printf '%s\n' "$found"
}

ssh_vps() {
  ssh -o BatchMode=yes "$VPS_HOST" "$@"
}

if [[ "$SKIP_LOCAL_BUILD" == "1" ]]; then
  log "SKIP_LOCAL_BUILD=1 — verifying existing standalone ..."
  verify_standalone_build || fail "Local standalone is incomplete. Unset SKIP_LOCAL_BUILD or run: npm run build"
else
  log "Building Next.js standalone locally (Turbopack) ..."
  export SKIP_BUILD_CHECKS="${SKIP_BUILD_CHECKS:-true}"
  npm run build
  verify_standalone_build || fail "Local next build did not produce a valid standalone tree"
fi

VPS_DIR="$(detect_vps_dir)"
log "Remote app dir: ${VPS_HOST}:${VPS_DIR}"

ssh_vps "test -f '${VPS_DIR}/docker-compose.yml' && test -f '${VPS_DIR}/Dockerfile.web'" \
  || fail "Remote ${VPS_DIR} is missing docker-compose.yml or Dockerfile.web"

log "Ensuring remote .next directories ..."
ssh_vps "mkdir -p '${VPS_DIR}/.next/standalone' '${VPS_DIR}/.next/static'"

log "Rsync .next/standalone/ → ${VPS_HOST}:${VPS_DIR}/.next/standalone/"
rsync -az --delete \
  --exclude '.env' \
  "$ROOT/.next/standalone/" \
  "${VPS_HOST}:${VPS_DIR}/.next/standalone/"

log "Rsync .next/static/ → ${VPS_HOST}:${VPS_DIR}/.next/static/"
rsync -az --delete \
  "$ROOT/.next/static/" \
  "${VPS_HOST}:${VPS_DIR}/.next/static/"

log "Remote: ${REMOTE_COMPOSE} build web && up -d --no-deps web"
ssh_vps "cd '${VPS_DIR}' && ${REMOTE_COMPOSE} build web && ${REMOTE_COMPOSE} up -d --no-deps web"

if [[ "$SKIP_SMOKE" == "1" ]]; then
  log "SKIP_SMOKE=1 — not curling /api/health"
else
  log "Smoke: remote curl http://127.0.0.1/api/health (Host: reloadsol.app)"
  if ssh_vps 'curl -fsS -H "Host: reloadsol.app" http://127.0.0.1/api/health >/dev/null'; then
    log "Remote /api/health OK"
  else
    log "WARN: remote localhost health check failed — trying ${SMOKE_URL}"
    if curl -fsS -H "Host: reloadsol.app" "$SMOKE_URL" >/dev/null; then
      log "Public health OK (${SMOKE_URL})"
    else
      log "WARN: smoke curl failed (${SMOKE_URL}). Check: ssh ${VPS_HOST} 'docker logs --tail=80 reloadsol-web'"
    fi
  fi
fi

log "Ship complete. VPS did not run host next build."
