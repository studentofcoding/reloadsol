#!/usr/bin/env python3
"""Check pattern training parquet readiness."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from pattern_features import (
    MIN_PATTERN_MACRO_F1,
    MIN_PATTERN_ROWS,
    MIN_PATTERN_ROWS_PER_CLASS,
    PATTERN_FEATURE_COLUMNS,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Check pattern ML dataset readiness")
    parser.add_argument("input", type=Path)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--meta", type=Path, default=None)
    args = parser.parse_args()

    if args.input.suffix == ".parquet":
        df = pd.read_parquet(args.input)
    else:
        df = pd.read_csv(args.input)

    missing = [c for c in PATTERN_FEATURE_COLUMNS if c not in df.columns]
    labeled = len(df.dropna(subset=["pattern_class"])) if "pattern_class" in df.columns else 0
    by_class = (
        {
            str(int(k)): int(v)
            for k, v in df["pattern_class"].value_counts(dropna=False).astype(int).items()
        }
        if "pattern_class" in df.columns
        else {}
    )

    winners = by_class.get("1", 0)
    losers = by_class.get("0", 0)
    train_ready = winners >= MIN_PATTERN_ROWS_PER_CLASS and losers >= MIN_PATTERN_ROWS_PER_CLASS
    ready = labeled >= MIN_PATTERN_ROWS and train_ready and not missing

    summary = {
        "labeled": labeled,
        "by_pattern_class": by_class,
        "winners": winners,
        "losers": losers,
        "missing_feature_columns": missing,
        "min_rows": MIN_PATTERN_ROWS,
        "min_rows_per_class": MIN_PATTERN_ROWS_PER_CLASS,
        "train_ready": train_ready,
        "ready": ready,
    }

    if args.meta and args.meta.exists():
        meta = json.loads(args.meta.read_text())
        macro_f1 = meta.get("metrics", {}).get("macro_f1")
        pattern_ready = meta.get("metrics", {}).get("pattern_ready")
        summary["model_macro_f1"] = macro_f1
        summary["model_pattern_ready"] = pattern_ready
        if macro_f1 is not None and macro_f1 < MIN_PATTERN_MACRO_F1:
            print(
                f"WARNING: model macro_f1 {macro_f1:.4f} below {MIN_PATTERN_MACRO_F1}"
            )

    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(json.dumps(summary, indent=2))
        if missing:
            print(f"Missing columns: {missing}")
        if not ready:
            print("Dataset not ready for pattern-gate training.")


if __name__ == "__main__":
    main()
