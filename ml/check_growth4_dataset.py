#!/usr/bin/env python3
"""Check a 4-class growth export: class counts, Pattern shadow, placeholder n."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from growth4 import (
    ENTRY_FEATURE_COLUMNS,
    GROWTH4_CLASS_NAMES,
    GROWTH4_CUTS,
    PLACEHOLDER_MACRO_F1,
    PLACEHOLDER_OOS_N,
    PLACEHOLDER_PER_CLASS_F1,
    PLACEHOLDER_TRAIN_N,
)


def load_table(path: Path) -> pd.DataFrame:
    if path.suffix == ".parquet":
        return pd.read_parquet(path)
    return pd.read_csv(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Check 4-class growth dataset")
    parser.add_argument("input", type=Path)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--meta", type=Path, default=None)
    args = parser.parse_args()

    df = load_table(args.input)
    if "growth_class" not in df.columns and "growth_class_name" not in df.columns:
        raise SystemExit("Missing growth_class — not a 4-class export")

    if "growth_class_name" in df.columns:
        counts = df["growth_class_name"].value_counts().to_dict()
        by_class = {name: int(counts.get(name, 0)) for name in GROWTH4_CLASS_NAMES}
    else:
        counts = df["growth_class"].value_counts().to_dict()
        by_class = {name: int(counts.get(i, 0)) for i, name in enumerate(GROWTH4_CLASS_NAMES)}

    labeled = int(sum(by_class.values()))
    missing_entry = [c for c in ENTRY_FEATURE_COLUMNS if c not in df.columns]
    ohlc_rows = 0
    if "ohlc_n" in df.columns:
        ohlc_rows = int((pd.to_numeric(df["ohlc_n"], errors="coerce").fillna(0) > 0).sum())

    pattern_shadow = {}
    if "pattern_shadow_class" in df.columns:
        series = pd.to_numeric(df["pattern_shadow_class"], errors="coerce")
        pattern_shadow = {
            "0": int((series == 0).sum()),
            "1": int((series == 1).sum()),
            "neutral": int(series.isna().sum()),
        }

    summary: dict[str, object] = {
        "labeled": labeled,
        "by_growth_class": by_class,
        "cuts": GROWTH4_CUTS,
        "covers_bep_band": by_class.get("bep", 0) > 0,
        "all_four_classes": all(by_class[name] > 0 for name in GROWTH4_CLASS_NAMES),
        "missing_entry_columns": missing_entry,
        "ohlc_rows": ohlc_rows,
        "by_pattern_shadow_class": pattern_shadow,
        "placeholder_train_n": PLACEHOLDER_TRAIN_N,
        "placeholder_oos_n": PLACEHOLDER_OOS_N,
        "labeled_at_least_train_floor": labeled >= PLACEHOLDER_TRAIN_N,
        "paper_size": "off",
    }

    if args.meta and args.meta.exists():
        meta = json.loads(args.meta.read_text())
        metrics = meta.get("metrics") or {}
        summary["model_macro_f1"] = metrics.get("macro_f1")
        summary["model_per_class"] = metrics.get("per_class")
        summary["model_growth4_ready"] = metrics.get("growth4_ready")
        summary["model_serve_mode"] = meta.get("serve_mode")
        macro = metrics.get("macro_f1")
        if isinstance(macro, (int, float)) and macro < PLACEHOLDER_MACRO_F1:
            print(
                f"NOTE: holdout macro_f1 {macro:.4f} is under the "
                f"{PLACEHOLDER_MACRO_F1} placeholder (not a size flip)"
            )
        per = metrics.get("per_class") or {}
        if isinstance(per, dict):
            for name, row in per.items():
                if not isinstance(row, dict):
                    continue
                f1 = row.get("f1")
                support = row.get("support") or 0
                if (
                    isinstance(f1, (int, float))
                    and support >= 30
                    and f1 < PLACEHOLDER_PER_CLASS_F1
                ):
                    print(f"NOTE: {name} F1 {f1:.4f} under {PLACEHOLDER_PER_CLASS_F1}")

    print(json.dumps(summary, indent=2))
    if not summary["all_four_classes"]:
        print("Dataset is missing one of loser/bep/winner/moonbag.")
    if missing_entry:
        print(f"Missing entry columns: {missing_entry}")


if __name__ == "__main__":
    main()
