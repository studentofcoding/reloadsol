#!/usr/bin/env bash
# Detect which Docker services need rebuild based on changed file paths.
# Usage:
#   docker-scope.sh detect [--base REF]     # git diff vs REF (default HEAD~1)
#   docker-scope.sh detect-working          # staged + unstaged vs HEAD
# Output: "web", "cron", or "web,cron"

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

classify_path() {
  local path="$1"

  case "$path" in
    main.go|worker_tracker.go|go.mod|go.sum|Dockerfile.cron)
      echo "cron"
      ;;
    docker-compose*.yml|.env.docker.example|scripts/docker-*)
      echo "both"
      ;;
    src/*|public/*|package.json|package-lock.json|.npmrc|next.config.*|tsconfig.json|tsconfig.*.json|tailwind.config.*|postcss.config.*|middleware.ts|Dockerfile.web|Dockerfile|components.json|eslint.config.*|.eslintrc*)
      echo "web"
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

detect_from_files() {
  local files="$1"
  local has_web=false has_cron=false
  local file scope

  if [[ -z "$files" ]]; then
    echo "web,cron"
    return
  fi

  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    scope="$(classify_path "$file")"
    case "$scope" in
      both)
        echo "web,cron"
        return
        ;;
      web) has_web=true ;;
      cron) has_cron=true ;;
    esac
  done <<< "$files"

  if [[ "$has_web" == true && "$has_cron" == true ]]; then
    echo "web,cron"
  elif [[ "$has_web" == true ]]; then
    echo "web"
  elif [[ "$has_cron" == true ]]; then
    echo "cron"
  else
    # Unclassified paths (docs only, etc.) — rebuild both to stay safe
    echo "web,cron"
  fi
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
