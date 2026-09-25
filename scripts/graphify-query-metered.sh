#!/usr/bin/env bash
# Run graphify query and print a live before/after token savings header.
# Usage: bash scripts/graphify-query-metered.sh [--budget N] "question"
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Default graph search budget (override with --budget or GRAPHIFY_QUERY_BUDGET).
BUDGET="${GRAPHIFY_QUERY_BUDGET:-8000}"
QUESTION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --budget)
      BUDGET="${2:?}"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [--budget N] \"question\""
      exit 0
      ;;
    *)
      if [[ -n "$QUESTION" ]]; then
        echo "Unexpected arg: $1" >&2
        exit 1
      fi
      QUESTION="$1"
      shift
      ;;
  esac
done

if [[ -z "$QUESTION" ]]; then
  echo "Usage: $0 [--budget N] \"question\"" >&2
  exit 1
fi

if [[ ! -f graphify-out/graph.json ]]; then
  echo "graphify-out/graph.json missing — run: graphify update ." >&2
  exit 1
fi

if [[ ! -f graphify-out/token-baseline.json ]]; then
  bash "$(dirname "$0")/graphify-refresh-baseline.sh"
fi

if [[ -f graphify-out/.graphify_python ]]; then
  PYTHON="$(cat graphify-out/.graphify_python)"
else
  PYTHON="$(command -v python3)"
fi

# Capture query body; keep stderr (skill-version warnings) out of the meter.
QUERY_OUT="$(graphify query "$QUESTION" --budget "$BUDGET" 2>/dev/null || true)"
if [[ -z "$QUERY_OUT" ]]; then
  QUERY_OUT="$(graphify query "$QUESTION" --budget "$BUDGET" 2>&1)"
fi

export GRAPHIFY_METER_QUESTION="$QUESTION"
export GRAPHIFY_METER_BUDGET="$BUDGET"
export GRAPHIFY_METER_QUERY_OUT="$QUERY_OUT"
"$PYTHON" <<'PY'
import json
import os
from datetime import datetime, timezone
from pathlib import Path

root = Path(".").resolve()
baseline = json.loads((root / "graphify-out" / "token-baseline.json").read_text(encoding="utf-8"))
before = int(baseline.get("naive_tokens") or 0)
query_out = os.environ.get("GRAPHIFY_METER_QUERY_OUT") or ""
question = os.environ.get("GRAPHIFY_METER_QUESTION") or ""
after = max(1, len(query_out) // 4)
saved = max(0, before - after)
ratio = round(before / after, 1) if after else 0.0

def fmt(n: int) -> str:
    return f"{n:,}"

header = (
    f"📉 Graphify  before ~{fmt(before)}  after ~{fmt(after)}  "
    f"saved ~{fmt(saved)} ({ratio}×)"
)
print(header)
print(query_out)

session_path = root / "graphify-out" / "session-savings.json"
if session_path.exists():
    try:
        session = json.loads(session_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        session = {"turns": [], "total_saved": 0, "total_before": 0, "total_after": 0}
else:
    session = {"turns": [], "total_saved": 0, "total_before": 0, "total_after": 0}

turn = {
    "question": question,
    "budget": int(os.environ.get("GRAPHIFY_METER_BUDGET") or 8000),
    "before": before,
    "after": after,
    "saved": saved,
    "ratio": ratio,
    "ts": datetime.now(timezone.utc).isoformat(),
}
session.setdefault("turns", []).append(turn)
session["total_before"] = int(session.get("total_before") or 0) + before
session["total_after"] = int(session.get("total_after") or 0) + after
session["total_saved"] = int(session.get("total_saved") or 0) + saved
session["updated_at"] = turn["ts"]
session_path.write_text(json.dumps(session, indent=2) + "\n", encoding="utf-8")
PY
