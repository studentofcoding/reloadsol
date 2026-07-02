#!/usr/bin/env bash
# Detect which Docker services need rebuild based on changed file paths.
# Usage:
#   docker-scope.sh detect [--base REF]     # git diff vs REF (default HEAD~1)
#   docker-scope.sh detect-working          # staged + unstaged vs HEAD
# Output: comma-separated scopes: web, cron, social, db, infra

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DEFAULT_SCOPE="web,cron,social"

classify_path() {
  local path="$1"

  case "$path" in
    main.go|worker_tracker.go|go.mod|go.sum|Dockerfile.cron)
      echo "cron"
      ;;
    social-ingest/*|social-ingest/Dockerfile)
      echo "social"
      ;;
    data/tracked-wallets.txt)
      echo "skip"
      ;;
    db/init/*|db/*)
      echo "db"
      ;;
    nginx/*)
      echo "infra"
      ;;
    docker-compose*.yml|.env.docker.example|scripts/docker-*)
      echo "all"
      ;;
    src/*|public/*|package.json|package-lock.json|.npmrc|next.config.*|tsconfig.json|tsconfig.*.json|tailwind.config.*|postcss.config.*|middleware.ts|Dockerfile.web|Dockerfile|components.json|eslint.config.*|.eslintrc*)
      echo "web"
      ;;
    ml/*)
      echo "skip"
      ;;
    *)
      echo ""
      ;;
  esac
}

collect_changed_files() {
  local base="${1:-HEAD~1}"
  if git rev-parse "$base" >/dev/null 2>&1; then
    git diff --name-only "$base"...HEAD 2>/dev/null || git diff --name-only "$base" HEAD
  else
    git diff --name-only HEAD~1 HEAD 2>/dev/null || true
  fi
}

collect_working_files() {
  {
    git diff --name-only HEAD
    git diff --name-only --cached
  } | sort -u
}

emit_scope() {
  local has_web="$1"
  local has_cron="$2"
  local has_social="$3"
  local has_db="$4"
  local has_infra="$5"
  local parts=()

  if [[ "$has_web" == true ]]; then parts+=("web"); fi
  if [[ "$has_cron" == true ]]; then parts+=("cron"); fi
  if [[ "$has_social" == true ]]; then parts+=("social"); fi
  if [[ "$has_db" == true ]]; then parts+=("db"); fi
  if [[ "$has_infra" == true ]]; then parts+=("infra"); fi

  if [[ ${#parts[@]} -eq 0 ]]; then
    echo ""
    return
  fi

  local IFS=,
  echo "${parts[*]}"
}

detect_from_files() {
  local files="$1"
  local has_web=false has_cron=false has_social=false has_db=false has_infra=false
  local file scope

  if [[ -z "$files" ]]; then
    echo "$DEFAULT_SCOPE"
    return
  fi

  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    scope="$(classify_path "$file")"
    case "$scope" in
      all)
        echo "$DEFAULT_SCOPE"
        return
        ;;
      web) has_web=true ;;
      cron) has_cron=true ;;
      social) has_social=true ;;
      db) has_db=true ;;
      infra) has_infra=true ;;
      skip) ;;
    esac
  done <<< "$files"

  emit_scope "$has_web" "$has_cron" "$has_social" "$has_db" "$has_infra"
}

cmd="${1:-detect}"
shift || true

case "$cmd" in
  detect)
    base="HEAD~1"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --base)
          base="$2"
          shift 2
          ;;
        *)
          shift
          ;;
      esac
    done
    detect_from_files "$(collect_changed_files "$base")"
    ;;
  detect-working)
    detect_from_files "$(collect_working_files)"
    ;;
  *)
    echo "Usage: docker-scope.sh detect [--base REF] | detect-working" >&2
    exit 1
    ;;
esac
