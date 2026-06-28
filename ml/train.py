#!/usr/bin/env python3
"""Train LightGBM multiclass classifier on entry features; export ONNX + meta."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, classification_report, f1_score

from features import FEATURE_COLUMNS, FEATURE_COLUMNS_V2, MIN_LABELED_OUTCOMES, NUM_CLASSES


def resolve_feature_columns(version: str) -> list[str]:
    if version == "v2":
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


def main() -> None:
    parser = argparse.ArgumentParser(description="Train entry ML model")
    parser.add_argument("--input", type=Path, required=True, help="Training parquet/csv")
    parser.add_argument("--version", default="v1", help="Artifact version folder")
    parser.add_argument("--output-dir", type=Path, help="Override artifact dir")
    parser.add_argument("--test-ratio", type=float, default=0.2, help="Time-based holdout ratio")
    parser.add_argument("--min-rows", type=int, default=MIN_LABELED_OUTCOMES)
    args = parser.parse_args()

    if args.input.suffix == ".parquet":
        df = pd.read_parquet(args.input)
    else:
        df = pd.read_csv(args.input)

    if len(df) < args.min_rows:
        raise SystemExit(
            f"Need at least {args.min_rows} labeled rows, got {len(df)}. "
            "Keep sim-track running or lower --min-rows for dry runs."
        )

    feature_columns = resolve_feature_columns(args.version)
    missing = [c for c in feature_columns if c not in df.columns]
    if missing:
        raise SystemExit(f"Missing feature columns: {missing}")

    class_counts = df["training_class"].value_counts().to_dict()
    if len(class_counts) < 2:
        print(
            "WARNING: single-class dataset — model will be trivial until more tiers appear.",
            class_counts,
        )

    train_df, test_df = time_split(df, args.test_ratio)
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
    accuracy = float(accuracy_score(y_true, pred))
    report = classification_report(y_true, pred, zero_division=0, output_dict=True)

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
        "model_type": "multiclass",
        "num_classes": NUM_CLASSES,
        "feature_columns": feature_columns,
        "train_rows": len(train_df),
        "test_rows": len(test_df),
        "class_counts": {str(k): int(v) for k, v in class_counts.items()},
        "metrics": {
            "macro_f1": macro_f1,
            "accuracy": accuracy,
            "classification_report": report,
            "gate_ready": gate_ready,
            "min_macro_f1_gate": min_f1_gate,
        },
        "feature_importance": feature_importance,
        "best_iteration": booster.best_iteration,
        "artifacts": {
            "lightgbm": lgb_path.name,
            "onnx": onnx_path.name if onnx_ok else None,
        },
    }

    meta_path = out_dir / "model.meta.json"
    meta_path.write_text(json.dumps(meta, indent=2) + "\n")

    print(f"Train rows: {len(train_df)}  Test rows: {len(test_df)}")
    print(f"Macro-F1: {macro_f1:.4f}  Accuracy: {accuracy:.4f}")
    print(f"Gate ready (macro-F1 ≥ {min_f1_gate}): {gate_ready}")
    print(f"Saved {lgb_path}")
    if onnx_ok:
        print(f"Saved {onnx_path}")
    print(f"Saved {meta_path}")


if __name__ == "__main__":
    main()
