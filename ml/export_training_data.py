#!/usr/bin/env python3
"""Export labeled strategy outcomes to parquet for ML training."""

from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path

import pandas as pd
import requests

from features import (
    FEATURE_COLUMNS,
    FEATURE_COLUMNS_V2,
    gate_class_from_training_class,
    is_volume_imputed,
    list_incomplete_ml_fields,
    potential_tier_from_training_class,
    read_training_class,
    row_to_feature_vector,
    row_to_feature_vector_v2,
)


def resolve_feature_columns(version: str) -> list[str]:
    if version == "v2":
        return FEATURE_COLUMNS_V2
    return FEATURE_COLUMNS


def resolve_row_to_vector(version: str):
    if version == "v2":
        return row_to_feature_vector_v2
    return row_to_feature_vector


def fetch_from_api(
    base_url: str,
    domain: str | None,
    secret: str | None,
    *,
    training_class_min: int | None = None,
) -> pd.DataFrame:
    params: dict[str, str | int] = {
        "format": "csv",
        "training_class_only": "true",
        "recompute_labels": "true",
        "limit": 5000,
    }
    if domain:
        params["domain"] = domain
    if training_class_min is not None:
        params["training_class_min"] = training_class_min
    if secret:
        params["key"] = secret

    url = f"{base_url.rstrip('/')}/api/strategies/outcomes"
    response = requests.get(url, params=params, timeout=120)
    response.raise_for_status()
    return pd.read_csv(io.StringIO(response.text))


def load_source_csv(path: Path) -> pd.DataFrame:
    return pd.read_csv(path)


def build_training_frame(
    raw: pd.DataFrame,
    recompute: bool = True,
    features: str = "v1",
) -> pd.DataFrame:
    row_to_vector = resolve_row_to_vector(features)
    records: list[dict] = []
    skipped_incomplete = 0
    skipped_label = 0
    incomplete_by_field: dict[str, int] = {
        "entry_mcap": 0,
        "organic_score": 0,
        "top_holders_pct": 0,
        "token_age_hours": 0,
    }
    volume_imputed = 0

    for _, row in raw.iterrows():
        row_dict = row.to_dict()
        label = read_training_class(row_dict, recompute=recompute)
        if label is None:
            skipped_label += 1
            continue
        feature_vec = row_to_vector(row_dict)
        if feature_vec is None:
            skipped_incomplete += 1
            for field in list_incomplete_ml_fields(row_dict):
                incomplete_by_field[field] = incomplete_by_field.get(field, 0) + 1
            continue
        if is_volume_imputed(row_dict):
            volume_imputed += 1
        gate_class = gate_class_from_training_class(label)
        potential_tier = potential_tier_from_training_class(label)
        records.append(
            {
                "id": row_dict.get("id"),
                "strategy_id": row_dict.get("strategy_id"),
                "domain": row_dict.get("domain"),
                "entry_at": row_dict.get("entry_at"),
                "training_class": label,
                "gate_class": gate_class,
                "potential_tier": potential_tier,
                **feature_vec,
            }
        )

    df = pd.DataFrame(records)
    print(
        f"Built {len(df)} training rows "
        f"(skipped {skipped_label} unlabeled, {skipped_incomplete} incomplete features)"
    )
    print(f"incomplete_by_field={incomplete_by_field}")
    print(f"volume_imputed={volume_imputed}")
    return df


def main() -> None:
    parser = argparse.ArgumentParser(description="Export ML training dataset")
    parser.add_argument(
        "--source",
        choices=["api", "csv"],
        default="api",
        help="Data source (default: api)",
    )
    parser.add_argument(
        "--csv",
        type=Path,
        help="Local CSV path when --source csv",
    )
    parser.add_argument(
        "--api-base",
        default=os.environ.get("API_BASE_URL", "http://127.0.0.1"),
        help="App base URL (prod host: http://127.0.0.1 via nginx, not :3000)",
    )
    parser.add_argument(
        "--secret",
        default=os.environ.get("TRENDING_TRACKER_SECRET"),
        help="Service auth for /api/strategies/outcomes (?key=)",
    )
    parser.add_argument(
        "--domain",
        default=os.environ.get("ML_TRAIN_DOMAIN"),
        help="Filter domain (default: all domains)",
    )
    parser.add_argument(
        "--training-class-min",
        type=int,
        default=None,
        help="Only export win tiers >= N (1–4)",
    )
    parser.add_argument(
        "--features",
        default=os.environ.get("ML_EXPORT_FEATURES", "v1"),
        choices=["v1", "v2"],
        help="Feature schema: v1=12 entry columns (gate/potential); v2=+social experimental export",
    )
    parser.add_argument(
        "--version",
        dest="features",
        choices=["v1", "v2"],
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/v2/training.parquet"),
        help="Output parquet (default: data/v2/training.parquet — v2 gate pipeline, not feature v2)",
    )
    args = parser.parse_args()

    if args.source == "csv":
        if not args.csv:
            parser.error("--csv required when --source csv")
        raw = load_source_csv(args.csv)
    else:
        if not args.secret:
            print(
                "WARNING: TRENDING_TRACKER_SECRET unset — API may return 401 "
                "(set env or pass --secret)"
            )
        raw = fetch_from_api(
            args.api_base,
            args.domain,
            args.secret,
            training_class_min=args.training_class_min,
        )

    df = build_training_frame(raw, features=args.features)
    if df.empty:
        raise SystemExit("No training rows — check dataset stats API or CSV filters")

    feature_columns = resolve_feature_columns(args.features)
    missing_cols = [c for c in feature_columns if c not in df.columns]
    if missing_cols:
        raise SystemExit(f"Missing feature columns: {missing_cols}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(args.output, index=False)
    gate_counts = (
        df["gate_class"].value_counts(dropna=False).astype(int).to_dict()
        if "gate_class" in df.columns
        else {}
    )
    tier_counts = (
        df["potential_tier"].dropna().value_counts().astype(int).to_dict()
        if "potential_tier" in df.columns
        else {}
    )
    manifest = {
        "features": args.features,
        "pipeline": "v2-gate",
        "rows": len(df),
        "feature_columns": feature_columns,
        "domain": args.domain,
        "source": args.source,
        "gate_class_counts": {str(k): int(v) for k, v in gate_counts.items()},
        "potential_tier_counts": {str(k): int(v) for k, v in tier_counts.items()},
    }
    manifest_path = args.output.parent / "dataset_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Wrote {args.output} ({len(df)} rows, {len(feature_columns)} features)")
    print(f"Wrote {manifest_path}")


if __name__ == "__main__":
    main()
