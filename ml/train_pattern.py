#!/usr/bin/env python3
"""Train binary pattern-gate model on 24h mcap+social cohort labels."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    f1_score,
    precision_recall_fscore_support,
)

from pattern_features import MIN_PATTERN_MACRO_F1, MIN_PATTERN_ROWS, PATTERN_FEATURE_COLUMNS

MIN_TEST_WINNERS = 5
MIN_TEST_LOSERS = 5


def time_split(
    df: pd.DataFrame,
    test_ratio: float,
    min_test_winners: int = MIN_TEST_WINNERS,
    min_test_losers: int = MIN_TEST_LOSERS,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    sort_col = "first_seen_at" if "first_seen_at" in df.columns else df.columns[0]
    ordered = df.sort_values(sort_col).reset_index(drop=True)
    n = len(ordered)
    split_idx = max(1, int(n * (1 - test_ratio)))
    if split_idx >= n:
        split_idx = n - 1

    min_train_rows = max(1, n - max(min_test_winners + min_test_losers, int(n * test_ratio)))

    while split_idx > min_train_rows and "pattern_class" in ordered.columns:
        test_slice = ordered.iloc[split_idx:]
        winners = int((test_slice["pattern_class"] == 1).sum())
        losers = int((test_slice["pattern_class"] == 0).sum())
        if winners >= min_test_winners and losers >= min_test_losers:
            break
        split_idx -= 1

    train_df = ordered.iloc[:split_idx]
    test_df = ordered.iloc[split_idx:]

    if "pattern_class" in test_df.columns and len(test_df) > 0:
        winners = int((test_df["pattern_class"] == 1).sum())
        losers = int((test_df["pattern_class"] == 0).sum())
        if winners < min_test_winners or losers < min_test_losers:
            print(
                f"WARNING: test split has win={winners} lose={losers} "
                f"(min {min_test_winners}/{min_test_losers})"
            )

    return train_df, test_df


def compute_scale_pos_weight(y_train: pd.Series) -> float:
    n_pos = int((y_train == 1).sum())
    n_neg = int((y_train == 0).sum())
    return n_neg / max(n_pos, 1)


def tune_decision_threshold(proba: np.ndarray, y_true: np.ndarray) -> tuple[float, float]:
    best_threshold = 0.5
    best_macro_f1 = 0.0
    for threshold in np.linspace(0.05, 0.95, 19):
        pred = (proba >= threshold).astype(int)
        macro_f1 = float(f1_score(y_true, pred, average="macro", zero_division=0))
        if macro_f1 > best_macro_f1:
            best_macro_f1 = macro_f1
            best_threshold = float(threshold)
    return best_threshold, best_macro_f1


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

    n_pos = int((y_train == 1).sum())
    n_neg = int((y_train == 0).sum())
    scale_pos_weight = compute_scale_pos_weight(y_train)

    train_set = lgb.Dataset(x_train, label=y_train, feature_name=feature_columns)
    valid_set = lgb.Dataset(x_test, label=y_test, feature_name=feature_columns, reference=train_set)

    params = {
        "objective": "binary",
        "metric": ["auc", "binary_logloss"],
        "scale_pos_weight": scale_pos_weight,
        "learning_rate": 0.05,
        "num_leaves": 31,
        "feature_fraction": 0.9,
        "bagging_fraction": 0.8,
        "bagging_freq": 1,
        "verbose": -1,
        "seed": 42,
    }

    print(f"Train class counts: lose={n_neg} win={n_pos} scale_pos_weight={scale_pos_weight:.2f}")

    booster = lgb.train(
        params,
        train_set,
        num_boost_round=300,
        valid_sets=[valid_set],
        callbacks=[
            lgb.early_stopping(stopping_rounds=30, verbose=False, first_metric_only=True),
        ],
    )

    proba = booster.predict(x_test, num_iteration=booster.best_iteration)
    y_true = y_test.to_numpy()
    decision_threshold, macro_f1 = tune_decision_threshold(proba, y_true)
    pred = (proba >= decision_threshold).astype(int)

    precision, recall, _, _ = precision_recall_fscore_support(
        y_true,
        pred,
        labels=[0, 1],
        zero_division=0,
    )
    pattern_ready = macro_f1 >= MIN_PATTERN_MACRO_F1 and len(test_df) >= 10

    meta_extra = {
        "model_type": "binary",
        "stage": "pattern-gate",
        "num_classes": 2,
        "label_column": "pattern_class",
        "class_counts": {str(k): int(v) for k, v in class_counts.items()},
        "training": {
            "scale_pos_weight": scale_pos_weight,
            "early_stopping_metric": "auc",
            "decision_threshold": decision_threshold,
            "train_class_counts": {"0": n_neg, "1": n_pos},
        },
        "metrics": {
            "macro_f1": macro_f1,
            "accuracy": float(accuracy_score(y_true, pred)),
            "winner_recall": float(recall[1]),
            "winner_precision": float(precision[1]),
            "decision_threshold": decision_threshold,
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
    training = meta_extra["training"]
    print(f"Train rows: {len(train_df)}  Test rows: {len(test_df)}")
    print(
        f"Macro-F1: {metrics['macro_f1']:.4f}  Accuracy: {metrics['accuracy']:.4f}  "
        f"threshold: {training['decision_threshold']:.2f}"
    )
    print(
        f"Winner recall: {metrics['winner_recall']:.4f}  "
        f"precision: {metrics['winner_precision']:.4f}"
    )
    print(f"Pattern ready: {metrics['pattern_ready']}")
    print(f"Saved {lgb_path}")
    if onnx_ok:
        print(f"Saved {onnx_path}")
    print(f"Saved {meta_path}")


if __name__ == "__main__":
    main()
