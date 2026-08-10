#!/usr/bin/env bash
# Daily Pattern ML pipeline: export → check → train (if ready) → reload ONNX.
# Runs on VPS host with system python3 (no venv). Cohort labels stay 24h via social_rollup cron.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DRY_RUN=false
FORCE_TRAIN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --force-train) FORCE_TRAIN=true ;;
    -h|--help)
      echo "Usage: bash scripts/ml-pattern-daily.sh [--dry-run] [--force-train]"
      exit 0
      ;;
  esac
done

mkdir -p logs
ARTIFACT_DIR="$ROOT/ml/artifacts/pattern-gate"
STATE_FILE="$ARTIFACT_DIR/pipeline_state.json"
PARQUET="$ROOT/ml/data/pattern/training.parquet"
META_FILE="$ARTIFACT_DIR/model.meta.json"
LOG_LINES=()

log() {
  echo "$@"
  LOG_LINES+=("$*")
}

write_state() {
  local status="$1"
  local export_rows="${2:-0}"
  local train_ready="${3:-false}"
  local train_skipped_reason="${4:-}"
  local trained_at="${5:-null}"
  local macro_f1="${6:-null}"
  local pattern_ready="${7:-null}"
  local web_reloaded="${8:-false}"
  local run_at
  run_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  mkdir -p "$ARTIFACT_DIR"
  python3 - "$STATE_FILE" "$run_at" "$status" "$export_rows" "$train_ready" \
    "$train_skipped_reason" "$trained_at" "$macro_f1" "$pattern_ready" "$web_reloaded" \
    "${LOG_LINES[@]}" <<'PY'
import json
import sys
from pathlib import Path

(
    path,
    run_at,
    status,
    export_rows,
    train_ready,
    train_skipped_reason,
    trained_at,
    macro_f1,
    pattern_ready,
    web_reloaded,
    *log_lines,
) = sys.argv[1:]

def opt_null(s: str):
    if s in ("", "null", "None"):
        return None
    return s

def opt_float(s: str):
    if s in ("", "null", "None"):
        return None
    return float(s)

def opt_bool(s: str):
    return s.lower() in ("true", "1", "yes")

state = {
    "last_run_at": run_at,
    "status": status,
    "export_rows": int(export_rows),
    "train_ready": opt_bool(train_ready),
    "train_skipped_reason": opt_null(train_skipped_reason) or None,
    "trained_at": opt_null(trained_at),
    "macro_f1": opt_float(macro_f1),
    "pattern_ready": opt_bool(pattern_ready) if pattern_ready not in ("null", "None", "") else None,
    "web_reloaded": opt_bool(web_reloaded),
    "log_tail": list(log_lines[-20:]),
}
Path(path).write_text(json.dumps(state, indent=2) + "\n")
PY
}

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  eval "$(bash scripts/load-env.sh .env)"
fi

if [[ -z "${TRENDING_TRACKER_SECRET:-}" ]]; then
  log "[ERROR] TRENDING_TRACKER_SECRET is not set"
  write_state "failed" 0 false "missing TRENDING_TRACKER_SECRET"
  exit 1
fi

export API_BASE_URL="${API_BASE_URL:-http://127.0.0.1}"

log "=== Pattern ML daily run $(date -u +"%Y-%m-%dT%H:%M:%SZ") ==="
log "API_BASE_URL=$API_BASE_URL dry_run=$DRY_RUN force_train=$FORCE_TRAIN"

if ! python3 -c "import pandas, lightgbm, requests" 2>/dev/null; then
  log "[ERROR] Missing python3 deps — run: pip3 install -r ml/requirements.txt"
  write_state "failed" 0 false "missing python3 dependencies"
  exit 1
fi

if ! (cd "$ROOT/ml" && python3 export_pattern_data.py --quiet --output data/pattern/training.parquet); then
  log "[ERROR] export_pattern_data.py failed"
  write_state "failed" 0 false "export failed"
  exit 1
fi
CHECK_JSON="$(cd "$ROOT/ml" && python3 check_pattern_dataset.py data/pattern/training.parquet --json 2>/dev/null || true)"
if [[ -z "$CHECK_JSON" ]]; then
  log "[ERROR] check_pattern_dataset.py produced no output"
  write_state "failed" 0 false "check failed"
  exit 1
fi

read -r EXPORT_ROWS TRAIN_READY DATASET_READY WINNERS LOSERS <<<"$(python3 -c "
import json, sys
s = json.loads(sys.argv[1])
print(s.get('labeled', 0), str(s.get('train_ready', False)).lower(), str(s.get('ready', False)).lower(), s.get('winners', 0), s.get('losers', 0))
" "$CHECK_JSON")"

log "Export rows: $EXPORT_ROWS (win=$WINNERS lose=$LOSERS train_ready=$TRAIN_READY ready=$DATASET_READY)"

if [[ "$DRY_RUN" == true ]]; then
  log "[dry-run] Skipping train and reload"
  write_state "partial" "$EXPORT_ROWS" "$TRAIN_READY" "dry-run (manual test)"
  log "Done status=partial reason=dry-run (manual test)"
  exit 0
fi

SHOULD_TRAIN=false
TRAIN_SKIP_REASON=""
if [[ "$FORCE_TRAIN" == true ]]; then
  SHOULD_TRAIN=true
elif [[ "$DATASET_READY" == true ]]; then
  SHOULD_TRAIN=true
else
  TRAIN_SKIP_REASON="need 30+ per class and 60+ rows (win=$WINNERS lose=$LOSERS labeled=$EXPORT_ROWS)"
  log "[skip] Train skipped: $TRAIN_SKIP_REASON"
fi

TRAINED_AT="null"
MACRO_F1="null"
PATTERN_READY="null"
WEB_RELOADED=false
RUN_STATUS="partial"

if [[ "$SHOULD_TRAIN" == true ]]; then
  if cd "$ROOT/ml" && python3 train_pattern.py --input data/pattern/training.parquet --version pattern-gate; then
    cd "$ROOT"
    log "Train completed"
    if [[ -f "$META_FILE" ]]; then
      read -r TRAINED_AT MACRO_F1 PATTERN_READY <<<"$(python3 -c "
import json, sys
m = json.load(open(sys.argv[1]))
metrics = m.get('metrics') or {}
print(m.get('trained_at', 'null'), metrics.get('macro_f1', 'null'), metrics.get('pattern_ready', 'null'))
" "$META_FILE")"
      log "Model trained_at=$TRAINED_AT macro_f1=$MACRO_F1 pattern_ready=$PATTERN_READY"

      RELOAD_URL="${API_BASE_URL%/}/api/ml/pattern/reload?key=${TRENDING_TRACKER_SECRET}"
      RELOAD_BODY="$(curl -sf -X POST "$RELOAD_URL" 2>/dev/null || true)"
      if [[ -n "$RELOAD_BODY" ]]; then
        RUNTIME_LOADED="$(python3 -c "
import json, sys
try:
  body = json.load(sys.stdin)
except json.JSONDecodeError:
  print('false')
  raise SystemExit
print('true' if body.get('runtime_loaded') is True else 'false')
" <<<"$RELOAD_BODY")"
        if [[ "$RUNTIME_LOADED" == "true" ]]; then
          WEB_RELOADED=true
          log "ONNX scorer reloaded via API (runtime_loaded=true)"
          RUN_STATUS="success"
        else
          log "[WARN] Reload API returned runtime_loaded=false — check docker logs for [ml-pattern]"
          log "[WARN] Response: $RELOAD_BODY"
          RUN_STATUS="partial"
          TRAIN_SKIP_REASON="reload runtime_loaded=false"
        fi
      elif docker restart reloadsol-web >/dev/null 2>&1; then
        WEB_RELOADED=true
        log "ONNX scorer reloaded via docker restart reloadsol-web"
        RUN_STATUS="success"
      else
        log "[WARN] Train OK but reload failed — restart web manually"
        RUN_STATUS="partial"
        TRAIN_SKIP_REASON="reload failed after train"
      fi
    else
      RUN_STATUS="partial"
      TRAIN_SKIP_REASON="model.meta.json missing after train"
    fi
  else
    cd "$ROOT"
    log "[ERROR] train_pattern.py failed"
    RUN_STATUS="partial"
    TRAIN_SKIP_REASON="train failed"
  fi
else
  RUN_STATUS="partial"
fi

write_state "$RUN_STATUS" "$EXPORT_ROWS" "$TRAIN_READY" "$TRAIN_SKIP_REASON" \
  "$TRAINED_AT" "$MACRO_F1" "$PATTERN_READY" "$WEB_RELOADED"
if [[ -n "$TRAIN_SKIP_REASON" ]]; then
  log "Done status=$RUN_STATUS reason=$TRAIN_SKIP_REASON"
else
  log "Done status=$RUN_STATUS"
fi

if [[ "$RUN_STATUS" == "failed" ]]; then
  exit 1
fi
