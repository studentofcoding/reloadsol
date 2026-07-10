#!/usr/bin/env python3
"""Check local training parquet/csv for ML readiness."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from features import (
    FEATURE_COLUMNS,
    MIN_LABELED_OUTCOMES,
    MIN_POTENTIAL_OUTCOMES,
    NUM_CLASSES,
    get_min_potential_outcomes,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Check ML training dataset readiness")
    parser.add_argument("input", type=Path, help="Parquet or CSV training file")
    parser.add_argument(
        "--stage",
        choices=["gate", "potential", "multiclass"],
        default="multiclass",
        help="Which training stage to validate",
    )
    parser.add_argument("--json", action="store_true", help="Print JSON summary")
    parser.add_argument(
        "--min-rows",
        type=int,
        default=None,
        help="Minimum labeled rows",
    )
    parser.add_argument(
        "--meta",
        type=Path,
        default=None,
        help="Optional model.meta.json — warn if macro_f1 below gate or suspiciously perfect",
    )
    args = parser.parse_args()

    if args.min_rows is None:
        args.min_rows = (
            get_min_potential_outcomes()
            if args.stage == "potential"
            else MIN_LABELED_OUTCOMES
        )

    if args.input.suffix == ".parquet":
        df = pd.read_parquet(args.input)
    else:
        df = pd.read_csv(args.input)

    missing = [c for c in FEATURE_COLUMNS if c not in df.columns]

    if args.stage == "gate":
        label_col = "gate_class"
        labeled = len(df) if label_col in df.columns else 0
        by_label = (
            {
                str(k): int(v)
                for k, v in df[label_col].value_counts(dropna=False).astype(int).items()
            }
            if labeled
            else {}
        )
        distinct = sum(1 for c in by_label.values() if c > 0)
    elif args.stage == "potential":
        label_col = "potential_tier"
        subset = df[df["gate_class"] == 1].dropna(subset=["potential_tier"]) if "gate_class" in df.columns else df.dropna(subset=["potential_tier"])
        labeled = len(subset)
        by_label = (
            {
                str(int(k)): int(v)
                for k, v in subset[label_col].value_counts().astype(int).items()
            }
            if labeled
            else {}
        )
        distinct = sum(1 for c in by_label.values() if c > 0)
    else:
        label_col = "training_class"
        labeled = len(df)
        by_label = {
            str(cls): int((df["training_class"] == cls).sum()) if labeled else 0
            for cls in range(NUM_CLASSES)
        }
        distinct = sum(1 for count in by_label.values() if count > 0)

    ready = labeled >= args.min_rows and not missing
    single_class = distinct < 2

    summary = {
        "stage": args.stage,
        "min_required": args.min_rows,
        "ready": ready,
        "single_class_warning": single_class,
        "labeled": labeled,
        "by_label": by_label,
        "distinct_classes": distinct,
        "missing_feature_columns": missing,
        "entry_at_range": {
            "earliest": str(df["entry_at"].min()) if labeled and "entry_at" in df else None,
            "latest": str(df["entry_at"].max()) if labeled and "entry_at" in df else None,
        },
    }

    if "gate_class" in df.columns:
        summary["gate_class_counts"] = {
            str(k): int(v)
            for k, v in df["gate_class"].value_counts(dropna=False).astype(int).items()
        }

    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(f"Stage: {args.stage}")
        print(f"Labeled rows: {labeled} (need {args.min_rows})")
        print(f"By {label_col}: {by_label}")
        if single_class:
            print("WARNING: single-class dataset — train will run but model is trivial")
        print(f"Ready: {ready}")
        if missing:
            print(f"Missing columns: {missing}")
        if "entry_at" in df.columns and labeled:
            print(f"Entry range: {summary['entry_at_range']['earliest']} → {summary['entry_at_range']['latest']}")

    if args.meta and args.meta.is_file():
        meta = json.loads(args.meta.read_text())
        metrics = meta.get("metrics") or {}
        macro_f1 = metrics.get("macro_f1")
        test_rows = meta.get("test_rows")
        gate = metrics.get("min_macro_f1_gate", 0.65)
        gate_ready = metrics.get("gate_ready")
        if macro_f1 is not None:
            print(f"Model macro-F1: {macro_f1} (gate ≥ {gate}, gate_ready={gate_ready})")
            if macro_f1 < gate:
                print(f"WARNING: macro-F1 below {gate} — not ready to gate live trades")
            if macro_f1 >= 0.99 and isinstance(test_rows, int) and test_rows < 100:
                print("WARNING: near-perfect metrics on small holdout — likely overfit / verification rot")

    if not summary["ready"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
