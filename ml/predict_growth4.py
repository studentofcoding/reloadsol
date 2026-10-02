#!/usr/bin/env python3
"""Shadow-serve stub for the 4-class head.

Loads ``model.lgb.txt`` + ``model.meta.json`` and prints one log line with
P(loser), P(bep), P(winner), P(moonbag). Does not read paper positions and
does not change size.

  cd ml
  python3 predict_growth4.py --artifact artifacts/growth4-ohlc --json '{"log_first_mcap": 11.0}'
  python3 predict_growth4.py --artifact artifacts/growth4-ohlc --input data/growth4/training.parquet
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np
import pandas as pd

from growth4 import (
    GROWTH4_CLASS_NAMES,
    format_shadow_log,
    probs_from_row,
)


def load_model(artifact_dir: Path) -> tuple[lgb.Booster, list[str]]:
    meta_path = artifact_dir / "model.meta.json"
    model_path = artifact_dir / "model.lgb.txt"
    if not meta_path.is_file() or not model_path.is_file():
        raise SystemExit(
            f"Missing {model_path.name} or {meta_path.name} under {artifact_dir}. "
            "Train with train_growth4.py first. This stub is not wired to paper size."
        )
    meta = json.loads(meta_path.read_text())
    if meta.get("wired_to_paper_size") is True:
        raise SystemExit("Refusing artifact with wired_to_paper_size=true")
    columns = meta.get("feature_columns")
    if not isinstance(columns, list) or not columns:
        raise SystemExit("model.meta.json missing feature_columns")
    booster = lgb.Booster(model_file=str(model_path))
    return booster, [str(c) for c in columns]


def vector_from_row(row: dict[str, Any], feature_columns: list[str]) -> np.ndarray:
    values: list[float] = []
    for col in feature_columns:
        raw = row.get(col, 0.0)
        try:
            num = float(raw)
        except (TypeError, ValueError):
            num = 0.0
        if num != num:  # NaN
            num = 0.0
        values.append(num)
    return np.asarray([values], dtype=float)


def predict_probs(
    booster: lgb.Booster,
    feature_columns: list[str],
    row: dict[str, Any],
) -> tuple[dict[str, float], str]:
    proba = booster.predict(vector_from_row(row, feature_columns))
    row_proba = np.asarray(proba)[0]
    probs = probs_from_row(row_proba)
    predicted = max(GROWTH4_CLASS_NAMES, key=lambda name: probs[name])
    return probs, predicted


def iter_rows(args: argparse.Namespace) -> list[dict[str, Any]]:
    if args.json:
        payload = json.loads(args.json)
        if not isinstance(payload, dict):
            raise SystemExit("--json must be one object")
        return [payload]
    if args.input:
        path = args.input
        frame = pd.read_parquet(path) if path.suffix == ".parquet" else pd.read_csv(path)
        if args.limit is not None:
            frame = frame.head(args.limit)
        return frame.to_dict(orient="records")
    raise SystemExit("Pass --json '{...}' or --input rows.parquet")


def main() -> None:
    parser = argparse.ArgumentParser(description="Log 4-class growth probabilities (shadow)")
    parser.add_argument(
        "--artifact",
        type=Path,
        default=Path(os.environ.get("ML_GROWTH4_ARTIFACT_DIR", "artifacts/growth4-ohlc")),
        help="Directory with model.lgb.txt and model.meta.json",
    )
    parser.add_argument("--json", help="One feature row as JSON")
    parser.add_argument("--input", type=Path, help="Parquet or CSV of feature rows")
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    booster, feature_columns = load_model(args.artifact)
    rows = iter_rows(args)
    if not rows:
        raise SystemExit("No rows to score")
    for row in rows:
        probs, predicted = predict_probs(booster, feature_columns, row)
        token = row.get("token_address")
        token_s = str(token) if token is not None and str(token) not in {"", "nan", "None"} else None
        print(format_shadow_log(probs, predicted, token_s))


if __name__ == "__main__":
    main()
