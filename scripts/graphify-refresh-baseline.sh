#!/usr/bin/env bash
# Refresh graphify-out/token-baseline.json (naive corpus tokens vs graph size).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p graphify-out

if [[ -f graphify-out/.graphify_python ]]; then
  PYTHON="$(cat graphify-out/.graphify_python)"
else
  PYTHON="$(command -v python3)"
fi

"$PYTHON" <<'PY'
import json
from datetime import datetime, timezone
from pathlib import Path

from graphify.detect import detect
from graphify.paths import load_node_link_graph

root = Path(".").resolve()
detection = detect(root)
words = int(detection.get("total_words") or 0)
graph_path = root / "graphify-out" / "graph.json"
if not graph_path.exists():
    raise SystemExit("graphify-out/graph.json missing — run graphify update . first")

G = load_node_link_graph(str(graph_path))
# Same formula as graphify.benchmark.run_benchmark
naive_tokens = words * 100 // 75 if words else max(1, G.number_of_nodes() * 50 * 100 // 75)

out = {
    "corpus_words": words,
    "naive_tokens": naive_tokens,
    "graph_nodes": G.number_of_nodes(),
    "graph_edges": G.number_of_edges(),
    "updated_at": datetime.now(timezone.utc).isoformat(),
}
path = root / "graphify-out" / "token-baseline.json"
path.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
print(
    f"Baseline: {out['corpus_words']:,} words → ~{out['naive_tokens']:,} naive tokens "
    f"({out['graph_nodes']:,} nodes)"
)
PY
