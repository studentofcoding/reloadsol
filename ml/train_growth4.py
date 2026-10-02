#!/usr/bin/env python3
"""Train/eval a 4-class growth head (loser / bep / winner / moonbag).

Offline only. Writes LightGBM + optional ONNX and model.meta.json.
``growth4_ready`` stays false: this step does not flip sleeve soft-size.

  cd ml
  python3 train_growth4.py --input data/growth4/training.parquet --version growth4-ohlc
"""

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

from growth4 import (
    GROWTH4_CLASS_INDEX,
    GROWTH4_CLASS_NAMES,
    GROWTH4_CUTS,
    MIN_GROWTH4_ROWS,
    PLACEHOLDER_MACRO_F1,
    PLACEHOLDER_OOS_N,
    PLACEHOLDER_PER_CLASS_F1,
    PLACEHOLDER_TRAIN_N,
    TINY_CLASS_SUPPORT,
    ohlc_feature_columns,
    LEAKY_OHLC_CLOCKS,
    resolve_feature_columns,
)

LEAKY_OHLC_BLOCKER = "ohlc_features_label_time_leakage"

READY_BLOCKERS_ALWAYS = (
    "lead_time_not_evaluated",
    "calibration_not_evaluated",
    "oos_sleeve_beat_not_evaluated",
)


def _json_safe(value: object) -> object:
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return float(value)
    if isinstance(value, np.ndarray):
        return [_json_safe(v) for v in value.tolist()]
    return value


def time_split(df: pd.DataFrame, test_ratio: float) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Pure time-ordered holdout: the latest ``test_ratio`` rows are test.

    The cut depends only on row order by ``first_seen_at``, never on labels, so
    the holdout is not tuned to contain every class. A class absent from test
    shows up as ``support: 0`` in the metrics.
    """
    if "first_seen_at" not in df.columns:
        raise SystemExit("time_split needs first_seen_at — re-export with export_growth4_data.py")
    if not 0 < test_ratio < 1:
        raise SystemExit(f"--test-ratio must be between 0 and 1, got {test_ratio}")
    ordered = df.copy()
    ordered["_sort_ts"] = pd.to_datetime(ordered["first_seen_at"], utc=True, errors="coerce")
    ordered = ordered.sort_values("_sort_ts", kind="mergesort", na_position="first")
    ordered = ordered.drop(columns="_sort_ts").reset_index(drop=True)
    n = len(ordered)
    split_idx = min(max(1, int(n * (1 - test_ratio))), n - 1)
    return ordered.iloc[:split_idx].reset_index(drop=True), ordered.iloc[split_idx:].reset_index(drop=True)


MIN_TRAIN_ROWS_FOR_VALID = 20


def carve_valid(train_df: pd.DataFrame, valid_ratio: float = 0.2) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Validation tail of the train split. Early stopping must not watch test.

    Fails loudly when the train split is too small to hold out a separate
    validation tail; validating on training rows would make early stopping
    meaningless.
    """
    if len(train_df) < MIN_TRAIN_ROWS_FOR_VALID:
        raise SystemExit(
            f"Train split has {len(train_df)} rows; need at least {MIN_TRAIN_ROWS_FOR_VALID} "
            "to carve a separate validation tail. Export more rows or lower --test-ratio."
        )
    split_idx = min(max(1, int(len(train_df) * (1 - valid_ratio))), len(train_df) - 1)
    return train_df.iloc[:split_idx], train_df.iloc[split_idx:]


def _class_weight_map(y: pd.Series) -> dict[int, float]:
    """Inverse-frequency weight per class, from ``y`` (the train split)."""
    counts = y.value_counts()
    n_classes = max(int(counts.shape[0]), 1)
    n = float(len(y))
    return {int(c): n / (n_classes * float(k)) for c, k in counts.items()}


def _weights_for(y: pd.Series, class_weights: dict[int, float]) -> np.ndarray:
    return y.map(lambda c: class_weights[int(c)]).to_numpy(dtype=float)


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


def _named_counts(series: pd.Series) -> dict[str, int]:
    counts = series.value_counts().to_dict()
    return {name: int(counts.get(GROWTH4_CLASS_INDEX[name], 0)) for name in GROWTH4_CLASS_NAMES}


def placeholder_report(
    macro_f1: float,
    per_class: dict[str, dict[str, float]],
    train_rows: int,
    test_rows: int,
) -> dict[str, object]:
    rare = [name for name, row in per_class.items() if int(row["support"]) < TINY_CLASS_SUPPORT]
    evaluated = [
        float(row["f1"]) >= PLACEHOLDER_PER_CLASS_F1
        for name, row in per_class.items()
        if name not in rare
    ]
    per_class_pass = bool(evaluated) and all(evaluated)
    macro_pass = macro_f1 >= PLACEHOLDER_MACRO_F1
    train_pass = train_rows >= PLACEHOLDER_TRAIN_N
    oos_pass = test_rows >= PLACEHOLDER_OOS_N
    blockers = list(READY_BLOCKERS_ALWAYS)
    if not macro_pass:
        blockers.append("macro_f1_below_placeholder")
    if not per_class_pass:
        blockers.append("per_class_f1_below_placeholder")
    if not train_pass:
        blockers.append("train_n_below_placeholder")
    if not oos_pass:
        blockers.append("oos_n_below_placeholder")
    return {
        "macro_f1_min": PLACEHOLDER_MACRO_F1,
        "per_class_f1_min": PLACEHOLDER_PER_CLASS_F1,
        "tiny_class_support": TINY_CLASS_SUPPORT,
        "train_labeled_min": PLACEHOLDER_TRAIN_N,
        "oos_labeled_min": PLACEHOLDER_OOS_N,
        "macro_f1_pass": macro_pass,
        "per_class_f1_pass": per_class_pass,
        "rare_classes_excluded": rare,
        "train_n_pass": train_pass,
        "oos_n_pass": oos_pass,
        "growth4_ready": False,
        "ready_blockers": blockers,
    }


def train_growth4(
    df: pd.DataFrame,
    feature_columns: list[str],
    test_ratio: float,
    min_rows: int,
    num_boost_round: int = 300,
    leaky_ohlc: bool = False,
) -> tuple[lgb.Booster, pd.DataFrame, pd.DataFrame, pd.DataFrame, dict]:
    if "growth_class" not in df.columns:
        raise SystemExit("Missing growth_class — re-export with export_growth4_data.py")
    if len(df) < min_rows:
        raise SystemExit(f"Need at least {min_rows} labeled rows, got {len(df)}.")

    present = set(int(c) for c in df["growth_class"].dropna().unique())
    missing = [name for name, idx in GROWTH4_CLASS_INDEX.items() if idx not in present]
    if missing:
        raise SystemExit(f"Need all 4 growth classes, missing {missing}")

    train_df, test_df = time_split(df, test_ratio)
    train_df, valid_df = carve_valid(train_df)
    train_present = set(int(c) for c in train_df["growth_class"].unique())
    if len(train_present) < 4:
        raise SystemExit(
            f"Train split is missing a class after the time split: "
            f"{_named_counts(train_df['growth_class'])}"
        )

    x_train = train_df[feature_columns]
    y_train = train_df["growth_class"].astype(int)
    x_valid = valid_df[feature_columns]
    y_valid = valid_df["growth_class"].astype(int)
    x_test = test_df[feature_columns]
    y_test = test_df["growth_class"].astype(int)
    # Same train-derived class weights for the early-stopping valid set, so the
    # stopping metric optimises what the weighted train loss optimises.
    class_weights = _class_weight_map(y_train)
    weights = _weights_for(y_train, class_weights)
    valid_weights = _weights_for(y_valid, class_weights)

    train_set = lgb.Dataset(
        x_train,
        label=y_train,
        weight=weights,
        feature_name=feature_columns,
    )
    valid_set = lgb.Dataset(
        x_valid,
        label=y_valid,
        weight=valid_weights,
        feature_name=feature_columns,
        reference=train_set,
    )
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
    print(f"Train class counts: {_named_counts(y_train)}")
    booster = lgb.train(
        params,
        train_set,
        num_boost_round=num_boost_round,
        valid_sets=[valid_set],
        callbacks=[lgb.early_stopping(stopping_rounds=30, verbose=False)],
    )

    iteration = booster.best_iteration or num_boost_round
    proba = booster.predict(x_test, num_iteration=iteration)
    pred = np.argmax(proba, axis=1)
    y_true = y_test.to_numpy()
    labels = list(GROWTH4_CLASS_INDEX.values())
    macro_f1 = float(f1_score(y_true, pred, average="macro", labels=labels, zero_division=0))
    precision, recall, f1_per, support = precision_recall_fscore_support(
        y_true,
        pred,
        labels=labels,
        zero_division=0,
    )
    per_class = {
        name: {
            "precision": float(precision[i]),
            "recall": float(recall[i]),
            "f1": float(f1_per[i]),
            "support": int(support[i]),
        }
        for i, name in enumerate(GROWTH4_CLASS_NAMES)
    }
    bars = placeholder_report(macro_f1, per_class, len(train_df), len(test_df))
    if leaky_ohlc:
        bars["ready_blockers"].append(LEAKY_OHLC_BLOCKER)
    meta_extra = {
        "model_type": "multiclass",
        "stage": "growth4-ohlc",
        "num_classes": 4,
        "label_column": "growth_class",
        "label_source": "token_mcap_tracking.mcap_growth_percent",
        "chain": "sol",
        "cuts": GROWTH4_CUTS,
        "class_index": GROWTH4_CLASS_INDEX,
        "class_names": list(GROWTH4_CLASS_NAMES),
        "class_counts": _named_counts(df["growth_class"]),
        "serve_mode": "shadow",
        "ohlc_label_time_leakage": leaky_ohlc,
        "wired_to_paper_size": False,
        "binary_pattern_shadow": "ml/export_pattern_data.py + ml/train_pattern.py unchanged",
        "training": {
            "sample_weight": "inverse_frequency",
            "valid_sample_weight": "inverse_frequency (train class weights)",
            "early_stopping_metric": "multi_logloss",
            "test_untouched_by_early_stopping": True,
        },
        "metrics": {
            "macro_f1": macro_f1,
            "accuracy": float(accuracy_score(y_true, pred)),
            "per_class": per_class,
            "classification_report": classification_report(
                y_true,
                pred,
                labels=labels,
                target_names=list(GROWTH4_CLASS_NAMES),
                zero_division=0,
                output_dict=True,
            ),
            "placeholder_bars": bars,
            "growth4_ready": False,
            "serve_mode": "shadow",
        },
    }
    return booster, train_df, valid_df, test_df, meta_extra


def load_table(path: Path) -> pd.DataFrame:
    if path.suffix == ".parquet":
        return pd.read_parquet(path)
    return pd.read_csv(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Train 4-class growth head")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--version", default="growth4-ohlc")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--test-ratio", type=float, default=0.2)
    parser.add_argument("--min-rows", type=int, default=MIN_GROWTH4_ROWS)
    parser.add_argument(
        "--features",
        choices=["entry", "auto", "ohlc", "all"],
        default="entry",
        help=(
            "entry (default; auto is an alias). ohlc/all use bars captured at label "
            "time, which leak the target, and need --allow-label-time-ohlc"
        ),
    )
    parser.add_argument(
        "--allow-label-time-ohlc",
        action="store_true",
        help="Diagnostic only: allow ohlc/all features. Marks the artifact leaky.",
    )
    parser.add_argument("--rounds", type=int, default=300)
    args = parser.parse_args()

    df = load_table(args.input)
    ohlc_present = "ohlc_n" in df.columns and bool((pd.to_numeric(df["ohlc_n"], errors="coerce").fillna(0) > 0).any())
    feature_columns = resolve_feature_columns(
        args.features, list(df.columns), ohlc_present, args.allow_label_time_ohlc
    )
    uses_ohlc = any(c in ohlc_feature_columns() for c in feature_columns)
    if uses_ohlc and "ohlc_clock" in df.columns:
        clocks = set(df["ohlc_clock"].dropna().astype(str)) & LEAKY_OHLC_CLOCKS
        print(f"WARNING: OHLC features with clock {sorted(clocks)} leak the label (diagnostic run).")
    print(f"Features ({args.features} → {len(feature_columns)} cols), ohlc_rows_present={ohlc_present}")

    booster, train_df, valid_df, test_df, meta_extra = train_growth4(
        df,
        feature_columns,
        args.test_ratio,
        args.min_rows,
        num_boost_round=args.rounds,
        leaky_ohlc=uses_ohlc,
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
        "feature_mode": args.features,
        "train_rows": len(train_df),
        "valid_rows": len(valid_df),
        "test_rows": len(test_df),
        "train_class_counts": _named_counts(train_df["growth_class"]),
        "valid_class_counts": _named_counts(valid_df["growth_class"]),
        "test_class_counts": _named_counts(test_df["growth_class"]),
        "feature_importance": feature_importance,
        "best_iteration": booster.best_iteration,
        "artifacts": {
            "lightgbm": lgb_path.name,
            "onnx": onnx_path.name if onnx_ok else None,
        },
        "artifact_dir_env": "ML_GROWTH4_ARTIFACT_DIR",
        **meta_extra,
    }
    meta_path = out_dir / "model.meta.json"
    meta_path.write_text(json.dumps(_json_safe(meta), indent=2) + "\n")

    metrics = meta_extra["metrics"]
    print(
        f"Train rows: {len(train_df)}  Valid rows: {len(valid_df)}  Test rows: {len(test_df)}"
    )
    print(f"Class counts: {meta_extra['class_counts']}")
    print(f"Holdout class counts: {meta['test_class_counts']}")
    print(f"Macro-F1 (test): {metrics['macro_f1']:.4f}  Accuracy: {metrics['accuracy']:.4f}")
    for name, row in metrics["per_class"].items():
        print(
            f"  {name}: P={row['precision']:.4f} R={row['recall']:.4f} "
            f"F1={row['f1']:.4f} n={row['support']}"
        )
    print(f"growth4_ready: {metrics['growth4_ready']} (shadow; paper size unchanged)")
    print(f"Saved {lgb_path}")
    if onnx_ok:
        print(f"Saved {onnx_path}")
    print(f"Saved {meta_path}")


if __name__ == "__main__":
    main()
