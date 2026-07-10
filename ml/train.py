#!/usr/bin/env python3
"""Train LightGBM entry models: gate (binary), potential (tier 1-4), or legacy multiclass."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, classification_report, f1_score

from features import (
    FEATURE_COLUMNS,
    FEATURE_COLUMNS_V2,
    MIN_LABELED_OUTCOMES,
    MIN_POTENTIAL_OUTCOMES,
    NUM_CLASSES,
    get_min_potential_outcomes,
)


def resolve_feature_columns(version: str) -> list[str]:
    if version.startswith("v2") and version != "v2-gate" and version != "v2-potential":
        return FEATURE_COLUMNS_V2
    return FEATURE_COLUMNS


def time_split(df: pd.DataFrame, test_ratio: float) -> tuple[pd.DataFrame, pd.DataFrame]:
    ordered = df.sort_values("entry_at").reset_index(drop=True)
    split_idx = max(1, int(len(ordered) * (1 - test_ratio)))
    if split_idx >= len(ordered):
        split_idx = len(ordered) - 1
    return ordered.iloc[:split_idx], ordered.iloc[split_idx:]


def export_onnx(model: lgb.Booster, output_path: Path, num_features: int) -> bool:
    try:
        from onnxmltools.convert import convert_lightgbm
        from onnxmltools.convert.common.data_types import FloatTensorType
        from onnxmltools.utils import save_model

        initial_types = [("input", FloatTensorType([None, num_features]))]
        onnx_model = convert_lightgbm(
            model,
            initial_types=initial_types,
            target_opset=12,
        )
        save_model(onnx_model, str(output_path))
        return True
    except Exception as exc:  # ponytail: optional path — native lgb always saved
        print(f"ONNX export skipped: {exc}")
        return False


def train_binary_gate(
    df: pd.DataFrame,
    feature_columns: list[str],
    test_ratio: float,
    min_rows: int,
) -> tuple[lgb.Booster, pd.DataFrame, pd.DataFrame, dict]:
    if "gate_class" not in df.columns:
        raise SystemExit("Missing gate_class column — re-export training data")

    if len(df) < min_rows:
        raise SystemExit(
            f"Need at least {min_rows} labeled rows for gate, got {len(df)}."
        )

    class_counts = df["gate_class"].value_counts().to_dict()
    if len(class_counts) < 2:
        print("WARNING: single gate class — model will be trivial.", class_counts)

    train_df, test_df = time_split(df, test_ratio)
    x_train = train_df[feature_columns]
    y_train = train_df["gate_class"].astype(int)
    x_test = test_df[feature_columns]
    y_test = test_df["gate_class"].astype(int)

    train_set = lgb.Dataset(x_train, label=y_train, feature_name=feature_columns)
    valid_set = lgb.Dataset(x_test, label=y_test, feature_name=feature_columns, reference=train_set)

    params = {
        "objective": "binary",
        "metric": ["binary_logloss", "binary_error"],
        "learning_rate": 0.05,
        "num_leaves": 31,
        "feature_fraction": 0.9,
        "bagging_fraction": 0.8,
        "bagging_freq": 1,
        "verbose": -1,
        "seed": 42,
    }

    booster = lgb.train(
        params,
        train_set,
        num_boost_round=300,
        valid_sets=[valid_set],
        callbacks=[lgb.early_stopping(stopping_rounds=30, verbose=False)],
    )

    proba = booster.predict(x_test, num_iteration=booster.best_iteration)
    pred = (proba >= 0.5).astype(int)
    y_true = y_test.to_numpy()
    macro_f1 = float(f1_score(y_true, pred, average="macro", zero_division=0))
    min_f1_gate = 0.65
    gate_ready = macro_f1 >= min_f1_gate and len(test_df) >= 20

    meta_extra = {
        "model_type": "binary",
        "stage": "gate",
        "num_classes": 2,
        "label_column": "gate_class",
        "class_counts": {str(k): int(v) for k, v in class_counts.items()},
        "metrics": {
            "macro_f1": macro_f1,
            "accuracy": float(accuracy_score(y_true, pred)),
            "classification_report": classification_report(
                y_true, pred, zero_division=0, output_dict=True
            ),
            "gate_ready": gate_ready,
            "min_macro_f1_gate": min_f1_gate,
        },
    }
    return booster, train_df, test_df, meta_extra


def train_potential_tier(
    df: pd.DataFrame,
    feature_columns: list[str],
    test_ratio: float,
    min_rows: int,
) -> tuple[lgb.Booster, pd.DataFrame, pd.DataFrame, dict]:
    if "gate_class" not in df.columns or "potential_tier" not in df.columns:
        raise SystemExit("Missing gate_class/potential_tier — re-export training data")

    winners = df[df["gate_class"] == 1].dropna(subset=["potential_tier"]).copy()
    winners["potential_tier"] = winners["potential_tier"].astype(int)

    if len(winners) < min_rows:
        raise SystemExit(
            f"Need at least {min_rows} gate=1 rows for potential model, got {len(winners)}."
        )

    class_counts = winners["potential_tier"].value_counts().to_dict()
    distinct_tiers = sum(1 for c in class_counts.values() if c > 0)
    if distinct_tiers < 2:
        raise SystemExit(
            f"Need at least 2 distinct potential tiers, got {distinct_tiers}: {class_counts}"
        )

    train_df, test_df = time_split(winners, test_ratio)
    x_train = train_df[feature_columns]
    # LightGBM multiclass expects 0-indexed labels
    y_train = train_df["potential_tier"].astype(int) - 1
    x_test = test_df[feature_columns]
    y_test = test_df["potential_tier"].astype(int) - 1

    train_set = lgb.Dataset(x_train, label=y_train, feature_name=feature_columns)
    valid_set = lgb.Dataset(x_test, label=y_test, feature_name=feature_columns, reference=train_set)

    params = {
        "objective": "multiclass",
        "num_class": 4,
        "metric": ["multi_logloss", "multi_error"],
        "learning_rate": 0.05,
        "num_leaves": 31,
        "feature_fraction": 0.9,
        "bagging_fraction": 0.8,
        "bagging_freq": 1,
        "verbose": -1,
        "seed": 42,
    }

    booster = lgb.train(
        params,
        train_set,
        num_boost_round=300,
        valid_sets=[valid_set],
        callbacks=[lgb.early_stopping(stopping_rounds=30, verbose=False)],
    )

    proba = booster.predict(x_test, num_iteration=booster.best_iteration)
    pred = np.argmax(proba, axis=1) + 1  # map 0-3 → tiers 1-4
    y_true = (y_test.to_numpy() + 1)  # back to tiers 1-4 for metrics
    macro_f1 = float(f1_score(y_true, pred, average="macro", zero_division=0))
    min_f1_gate = 0.55
    gate_ready = macro_f1 >= min_f1_gate and len(test_df) >= 10

    meta_extra = {
        "model_type": "potential_tier",
        "stage": "potential",
        "num_classes": 4,
        "label_column": "potential_tier",
        "potential_tier_min": 1,
        "potential_tier_max": 4,
        "class_counts": {str(k): int(v) for k, v in class_counts.items()},
        "metrics": {
            "macro_f1": macro_f1,
            "accuracy": float(accuracy_score(y_true, pred)),
            "classification_report": classification_report(
                y_true, pred, zero_division=0, output_dict=True
            ),
            "gate_ready": gate_ready,
            "min_macro_f1_gate": min_f1_gate,
        },
    }
    return booster, train_df, test_df, meta_extra


def train_multiclass_legacy(
    df: pd.DataFrame,
    feature_columns: list[str],
    test_ratio: float,
    min_rows: int,
) -> tuple[lgb.Booster, pd.DataFrame, pd.DataFrame, dict]:
    if len(df) < min_rows:
        raise SystemExit(
            f"Need at least {min_rows} labeled rows, got {len(df)}."
        )

    class_counts = df["training_class"].value_counts().to_dict()
    if len(class_counts) < 2:
        print(
            "WARNING: single-class dataset — model will be trivial until more tiers appear.",
            class_counts,
        )

    train_df, test_df = time_split(df, test_ratio)
    x_train = train_df[feature_columns]
    y_train = train_df["training_class"].astype(int)
    x_test = test_df[feature_columns]
    y_test = test_df["training_class"].astype(int)

    train_set = lgb.Dataset(x_train, label=y_train, feature_name=feature_columns)
    valid_set = lgb.Dataset(x_test, label=y_test, feature_name=feature_columns, reference=train_set)

    params = {
        "objective": "multiclass",
        "num_class": NUM_CLASSES,
        "metric": ["multi_logloss", "multi_error"],
        "learning_rate": 0.05,
        "num_leaves": 31,
        "feature_fraction": 0.9,
        "bagging_fraction": 0.8,
        "bagging_freq": 1,
        "verbose": -1,
        "seed": 42,
    }

    booster = lgb.train(
        params,
        train_set,
        num_boost_round=300,
        valid_sets=[valid_set],
        callbacks=[lgb.early_stopping(stopping_rounds=30, verbose=False)],
    )

    proba = booster.predict(x_test, num_iteration=booster.best_iteration)
    pred = np.argmax(proba, axis=1)
    y_true = y_test.to_numpy()
    macro_f1 = float(f1_score(y_true, pred, average="macro", zero_division=0))
    min_f1_gate = 0.65
    gate_ready = macro_f1 >= min_f1_gate and len(test_df) >= 20

    meta_extra = {
        "model_type": "multiclass",
        "stage": "multiclass",
        "num_classes": NUM_CLASSES,
        "label_column": "training_class",
        "class_counts": {str(k): int(v) for k, v in class_counts.items()},
        "metrics": {
            "macro_f1": macro_f1,
            "accuracy": float(accuracy_score(y_true, pred)),
            "classification_report": classification_report(
                y_true, pred, zero_division=0, output_dict=True
            ),
            "gate_ready": gate_ready,
            "min_macro_f1_gate": min_f1_gate,
        },
    }
    return booster, train_df, test_df, meta_extra


def main() -> None:
    parser = argparse.ArgumentParser(description="Train entry ML model")
    parser.add_argument("--input", type=Path, required=True, help="Training parquet/csv")
    parser.add_argument(
        "--stage",
        choices=["gate", "potential", "multiclass"],
        default="multiclass",
        help="Training stage (default: legacy multiclass)",
    )
    parser.add_argument("--version", default="v1", help="Artifact version folder")
    parser.add_argument("--output-dir", type=Path, help="Override artifact dir")
    parser.add_argument("--test-ratio", type=float, default=0.2, help="Time-based holdout ratio")
    parser.add_argument("--min-rows", type=int, default=None, help="Minimum labeled rows")
    args = parser.parse_args()

    if args.input.suffix == ".parquet":
        df = pd.read_parquet(args.input)
    else:
        df = pd.read_csv(args.input)

    min_rows = args.min_rows
    if min_rows is None:
        min_rows = (
            get_min_potential_outcomes()
            if args.stage == "potential"
            else MIN_LABELED_OUTCOMES
        )

    feature_columns = resolve_feature_columns(args.version)
    missing = [c for c in feature_columns if c not in df.columns]
    if missing:
        raise SystemExit(f"Missing feature columns: {missing}")

    if args.stage == "gate":
        booster, train_df, test_df, meta_extra = train_binary_gate(
            df, feature_columns, args.test_ratio, min_rows
        )
    elif args.stage == "potential":
        booster, train_df, test_df, meta_extra = train_potential_tier(
            df, feature_columns, args.test_ratio, min_rows
        )
    else:
        booster, train_df, test_df, meta_extra = train_multiclass_legacy(
            df, feature_columns, args.test_ratio, min_rows
        )

    importance = booster.feature_importance(importance_type="gain")
    feature_importance = {
        name: float(score)
        for name, score in sorted(
            zip(feature_columns, importance, strict=True),
            key=lambda item: item[1],
            reverse=True,
        )
    }

    out_dir = args.output_dir or Path("artifacts") / args.version
    out_dir.mkdir(parents=True, exist_ok=True)

    lgb_path = out_dir / "model.lgb.txt"
    booster.save_model(str(lgb_path))

    onnx_path = out_dir / "model.onnx"
    onnx_ok = export_onnx(booster, onnx_path, len(feature_columns))

    meta = {
        "version": args.version,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "feature_columns": feature_columns,
        "train_rows": len(train_df),
        "test_rows": len(test_df),
        "feature_importance": feature_importance,
        "best_iteration": booster.best_iteration,
        "artifacts": {
            "lightgbm": lgb_path.name,
            "onnx": onnx_path.name if onnx_ok else None,
        },
        **meta_extra,
    }

    meta_path = out_dir / "model.meta.json"
    meta_path.write_text(json.dumps(meta, indent=2) + "\n")

    metrics = meta_extra["metrics"]
    print(f"Stage: {args.stage}")
    print(f"Train rows: {len(train_df)}  Test rows: {len(test_df)}")
    print(f"Macro-F1: {metrics['macro_f1']:.4f}  Accuracy: {metrics['accuracy']:.4f}")
    print(f"Gate ready: {metrics['gate_ready']}")
    print(f"Saved {lgb_path}")
    if onnx_ok:
        print(f"Saved {onnx_path}")
    print(f"Saved {meta_path}")


if __name__ == "__main__":
    main()
