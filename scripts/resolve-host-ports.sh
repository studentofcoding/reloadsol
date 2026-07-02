#!/usr/bin/env bash
# Resolve published host ports from running containers (docker port first, then .env).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

read_env_var() {
  local key="$1"
  if [[ ! -f .env ]]; then
    return 1
  fi
  grep -E "^${key}=" .env | tail -1 | cut -d= -f2- | tr -d '"'"'"
}

resolve_web_host_port() {
  local from_nginx from_docker from_env

  if docker inspect reloadsol-nginx >/dev/null 2>&1; then
    from_nginx="$(docker port reloadsol-nginx 80/tcp 2>/dev/null | head -1 | sed 's/.*://')"
    if [[ -n "$from_nginx" ]]; then
      echo "$from_nginx"
      return
    fi
  fi

  from_docker="$(docker port reloadsol-web 3000/tcp 2>/dev/null | head -1 | sed 's/.*://')"
  if [[ -n "$from_docker" ]]; then
    echo "$from_docker"
    return
  fi

  from_env="$(read_env_var WEB_PORT 2>/dev/null || true)"
  if [[ -n "$from_env" ]]; then
    echo "$from_env"
    return
  fi

  echo "${WEB_PORT:-80}"
}

resolve_cron_host_port() {
  local from_docker from_env

  from_docker="$(docker port reloadsol-cron 8080/tcp 2>/dev/null | head -1 | sed 's/.*://')"
  if [[ -n "$from_docker" ]]; then
    echo "$from_docker"
    return
  fi

  from_env="$(read_env_var CRON_PORT 2>/dev/null || true)"
  if [[ -n "$from_env" ]]; then
    echo "$from_env"
    return
  fi

  echo "${CRON_PORT:-8080}"
}

case "${1:-}" in
  web) resolve_web_host_port ;;
  cron) resolve_cron_host_port ;;
  *)
    echo "Usage: $0 web|cron" >&2
    exit 1
    ;;
esac
