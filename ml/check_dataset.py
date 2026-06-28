#!/usr/bin/env python3
"""Check local training parquet/csv for ML readiness."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from features import FEATURE_COLUMNS, MIN_LABELED_OUTCOMES, NUM_CLASSES


def main() -> None:
    parser = argparse.ArgumentParser(description="Check ML training dataset readiness")
    parser.add_argument("input", type=Path, help="Parquet or CSV training file")
    parser.add_argument("--json", action="store_true", help="Print JSON summary")
    parser.add_argument(
        "--min-rows",
        type=int,
        default=MIN_LABELED_OUTCOMES,
        help="Minimum labeled rows",
    )
    args = parser.parse_args()

    if args.input.suffix == ".parquet":
        df = pd.read_parquet(args.input)
    else:
        df = pd.read_csv(args.input)

    labeled = len(df)
    by_class = {
        str(cls): int((df["training_class"] == cls).sum()) if labeled else 0
        for cls in range(NUM_CLASSES)
    }
    distinct_classes = sum(1 for count in by_class.values() if count > 0)
    ready = labeled >= args.min_rows
    missing = [c for c in FEATURE_COLUMNS if c not in df.columns]
    single_class = distinct_classes < 2

    summary = {
        "min_required": args.min_rows,
        "ready": ready and not missing,
        "single_class_warning": single_class,
        "labeled": labeled,
        "by_class": by_class,
        "distinct_classes": distinct_classes,
        "missing_feature_columns": missing,
        "entry_at_range": {
            "earliest": str(df["entry_at"].min()) if labeled and "entry_at" in df else None,
            "latest": str(df["entry_at"].max()) if labeled and "entry_at" in df else None,
        },
    }

    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(f"Labeled rows: {labeled} (need {args.min_rows})")
        print(f"By class: {by_class}")
        if single_class:
            print("WARNING: single-class dataset — train will run but model is trivial")
        print(f"Ready: {summary['ready']}")
        if missing:
            print(f"Missing columns: {missing}")
        if "entry_at" in df.columns and labeled:
            print(f"Entry range: {summary['entry_at_range']['earliest']} → {summary['entry_at_range']['latest']}")

    if not summary["ready"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
