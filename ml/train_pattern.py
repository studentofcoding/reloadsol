#!/usr/bin/env python3
"""Train binary pattern-gate model on 24h mcap+social cohort labels."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import pandas as pd
from sklearn.metrics import accuracy_score, classification_report, f1_score

from pattern_features import MIN_PATTERN_MACRO_F1, MIN_PATTERN_ROWS, PATTERN_FEATURE_COLUMNS


def time_split(df: pd.DataFrame, test_ratio: float) -> tuple[pd.DataFrame, pd.DataFrame]:
    sort_col = "first_seen_at" if "first_seen_at" in df.columns else df.columns[0]
    ordered = df.sort_values(sort_col).reset_index(drop=True)
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
    except Exception as exc:
        print(f"ONNX export skipped: {exc}")
        return False


def train_pattern_gate(
    df: pd.DataFrame,
    feature_columns: list[str],
    test_ratio: float,
    min_rows: int,
) -> tuple[lgb.Booster, pd.DataFrame, pd.DataFrame, dict]:
    if "pattern_class" not in df.columns:
        raise SystemExit("Missing pattern_class column — re-export pattern training data")

    if len(df) < min_rows:
        raise SystemExit(f"Need at least {min_rows} labeled rows, got {len(df)}.")

    class_counts = df["pattern_class"].value_counts().to_dict()
    if len(class_counts) < 2:
        print("WARNING: single pattern class — model will be trivial.", class_counts)

    train_df, test_df = time_split(df, test_ratio)
    x_train = train_df[feature_columns]
    y_train = train_df["pattern_class"].astype(int)
    x_test = test_df[feature_columns]
    y_test = test_df["pattern_class"].astype(int)

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
    pattern_ready = macro_f1 >= MIN_PATTERN_MACRO_F1 and len(test_df) >= 10

    meta_extra = {
        "model_type": "binary",
        "stage": "pattern-gate",
        "num_classes": 2,
        "label_column": "pattern_class",
        "class_counts": {str(k): int(v) for k, v in class_counts.items()},
        "metrics": {
            "macro_f1": macro_f1,
            "accuracy": float(accuracy_score(y_true, pred)),
            "classification_report": classification_report(
                y_true, pred, zero_division=0, output_dict=True
            ),
            "pattern_ready": pattern_ready,
            "min_macro_f1_pattern": MIN_PATTERN_MACRO_F1,
        },
    }
    return booster, train_df, test_df, meta_extra


def main() -> None:
    parser = argparse.ArgumentParser(description="Train pattern-gate ML model")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--version", default="pattern-gate")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--test-ratio", type=float, default=0.2)
    parser.add_argument("--min-rows", type=int, default=MIN_PATTERN_ROWS)
    args = parser.parse_args()

    if args.input.suffix == ".parquet":
        df = pd.read_parquet(args.input)
    else:
        df = pd.read_csv(args.input)

    missing = [c for c in PATTERN_FEATURE_COLUMNS if c not in df.columns]
    if missing:
        raise SystemExit(f"Missing feature columns: {missing}")

    booster, train_df, test_df, meta_extra = train_pattern_gate(
        df,
        PATTERN_FEATURE_COLUMNS,
        args.test_ratio,
        args.min_rows,
    )

    importance = booster.feature_importance(importance_type="gain")
    feature_importance = {
        name: float(score)
        for name, score in sorted(
            zip(PATTERN_FEATURE_COLUMNS, importance, strict=True),
            key=lambda item: item[1],
            reverse=True,
        )
    }

    out_dir = args.output_dir or Path("artifacts") / args.version
    out_dir.mkdir(parents=True, exist_ok=True)

    lgb_path = out_dir / "model.lgb.txt"
    booster.save_model(str(lgb_path))

    onnx_path = out_dir / "model.onnx"
    onnx_ok = export_onnx(booster, onnx_path, len(PATTERN_FEATURE_COLUMNS))

    meta = {
        "version": args.version,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "feature_columns": PATTERN_FEATURE_COLUMNS,
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
    print(f"Train rows: {len(train_df)}  Test rows: {len(test_df)}")
    print(f"Macro-F1: {metrics['macro_f1']:.4f}  Accuracy: {metrics['accuracy']:.4f}")
    print(f"Pattern ready: {metrics['pattern_ready']}")
    print(f"Saved {lgb_path}")
    if onnx_ok:
        print(f"Saved {onnx_path}")
    print(f"Saved {meta_path}")


if __name__ == "__main__":
    main()
