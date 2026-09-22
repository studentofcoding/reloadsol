#!/usr/bin/env bash
# ship-standalone-to-vps.sh
#
# Run on the build machine (Mac / CI), not on the ~3.6Gi VPS.
# Turbopack `next build` locally, rsync `.next/standalone` + `.next/static`,
# then rebuild only the web image on the VPS (no host `next build` there).
#
# Usage (from repo root):
#   bash scripts/ship-standalone-to-vps.sh
#   VPS_HOST=flowey-vps VPS_DIR=/home/ubuntu/reloadsol bash scripts/ship-standalone-to-vps.sh
#   SKIP_LOCAL_BUILD=1 bash scripts/ship-standalone-to-vps.sh   # reuse verified .next at HEAD
#
# Env:
#   VPS_HOST          SSH host (default: flowey-vps)
#   VPS_DIR           Remote app path (default: /home/ubuntu/reloadsol, then probe)
#   SKIP_LOCAL_BUILD=1  Skip `npm run build` when local standalone already verifies
#   SKIP_REMOTE_PULL=1  Do not git pull on the VPS before rsync
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
# sharp is the same class of bug with a harder failure: a Mac standalone traces
# @img/sharp-darwin-* only, and dlopen of that Mach-O in the Linux container is
# SIGSEGV (exit 139 / Cloudflare 522). This script strips those Darwin packages
# from the shipped tree. Dockerfile.web then installs the lockfile sharp build
# for linux-x64 glibc — do not rely on the Mac binary as the only sharp.node.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/verify-standalone-build.sh
source "$ROOT/scripts/verify-standalone-build.sh"
source "$ROOT/scripts/standalone-git-stamp.sh"

# Logs must go to stderr — stdout is captured for detect_vps_dir.
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ship-standalone] $*" >&2
}

fail() {
  log "ERROR: $*"
  exit 1
}

VPS_HOST="${VPS_HOST:-flowey-vps}"
DEFAULT_VPS_DIR="/home/ubuntu/reloadsol"
SKIP_LOCAL_BUILD="${SKIP_LOCAL_BUILD:-0}"
SKIP_REMOTE_PULL="${SKIP_REMOTE_PULL:-0}"
SKIP_SMOKE="${SKIP_SMOKE:-0}"
SMOKE_URL="${SMOKE_URL:-https://reloadsol.app/api/health}"
REMOTE_COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

ssh_vps() {
  ssh -o BatchMode=yes "$VPS_HOST" "$@"
}

detect_vps_dir() {
  if [[ -n "${VPS_DIR:-}" ]]; then
    printf '%s\n' "$VPS_DIR"
    return 0
  fi

  log "VPS_DIR unset — trying ${DEFAULT_VPS_DIR}, then probing ${VPS_HOST} ..."
  if ssh_vps "test -f '${DEFAULT_VPS_DIR}/docker-compose.yml' && test -f '${DEFAULT_VPS_DIR}/Dockerfile.web'"; then
    printf '%s\n' "$DEFAULT_VPS_DIR"
    return 0
  fi

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
  found="$(printf '%s\n' "$found" | tr -d '\r' | tail -n 1)"
  [[ -n "$found" ]] || fail "Could not detect remote app dir on ${VPS_HOST}. Set VPS_DIR=/path/to/reloadsol"
  printf '%s\n' "$found"
}

ensure_local_standalone() {
  if VERIFY_STANDALONE_QUIET=1 verify_standalone_build \
    && VERIFY_STANDALONE_QUIET=1 standalone_git_sha_matches_head; then
    log "Local standalone already matches git HEAD — skipping next build"
    return 0
  fi

  if [[ "$SKIP_LOCAL_BUILD" == "1" ]]; then
    verify_standalone_build || fail "Local standalone is incomplete. Unset SKIP_LOCAL_BUILD or run: npm run build"
    standalone_git_sha_matches_head || fail "Local standalone git stamp is stale. Unset SKIP_LOCAL_BUILD and rebuild."
    return 0
  fi

  log "Building Next.js standalone locally (Turbopack) ..."
  export SKIP_BUILD_CHECKS="${SKIP_BUILD_CHECKS:-true}"
  npm run build
  verify_standalone_build || fail "Local next build did not produce a valid standalone tree"
}

abort_stuck_remote_next_build() {
  log "Aborting leftover host next build on ${VPS_HOST} (if any) ..."
  ssh_vps 'bash -s' <<'EOS' || true
pkill -9 -f "[s]cripts/docker-deploy.sh" 2>/dev/null || true
pkill -9 -f "[n]ext-build" 2>/dev/null || true
pkill -9 -f "[n]ext/dist/bin/next" 2>/dev/null || true
pkill -9 -f "sh -c next build" 2>/dev/null || true
EOS
}

ensure_local_standalone

VPS_DIR="$(detect_vps_dir)"
log "Remote app dir: ${VPS_HOST}:${VPS_DIR}"

ssh_vps "test -f '${VPS_DIR}/docker-compose.yml' && test -f '${VPS_DIR}/Dockerfile.web'" \
  || fail "Remote ${VPS_DIR} is missing docker-compose.yml or Dockerfile.web"

abort_stuck_remote_next_build

if [[ "$SKIP_REMOTE_PULL" != "1" ]]; then
  local_sha="$(current_git_sha)"
  local_branch="$(git rev-parse --abbrev-ref HEAD)"
  log "Remote git fetch/pull ${local_branch} so VPS HEAD can match ${local_sha:0:12} ..."
  ssh_vps "cd '${VPS_DIR}' && git fetch origin && git checkout -- package-lock.json 2>/dev/null || true; git pull --ff-only origin '${local_branch}'"
fi

stamp_standalone_git_sha

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

# Mirror the onnxruntime note: a Mac ship may contain Darwin native addons.
# onnxruntime is allowed to (.so or .dylib). sharp must not — Darwin .node is
# removed here so it is never the only binary Docker could load. linux-x64
# sharp is installed in Dockerfile.web from the lockfile version.
log "Stripping Darwin sharp binaries from shipped standalone (Dockerfile.web installs linux-x64 sharp) ..."
ssh_vps "cd '${VPS_DIR}' && if [ -d .next/standalone/node_modules ]; then find .next/standalone/node_modules -type d \\( -name 'sharp-darwin-arm64' -o -name 'sharp-darwin-x64' -o -name 'sharp-libvips-darwin-arm64' -o -name 'sharp-libvips-darwin-x64' \\) -print0 | xargs -0 -r rm -rf; fi"

log "Remote: ${REMOTE_COMPOSE} build web && up -d --no-deps web"
ssh_vps "cd '${VPS_DIR}' && ${REMOTE_COMPOSE} build web && ${REMOTE_COMPOSE} up -d --no-deps web"

log "Starting cron/social if they were left stopped by a failed host build ..."
ssh_vps "docker start reloadsol-cron reloadsol-social-ingest 2>/dev/null || true"

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
