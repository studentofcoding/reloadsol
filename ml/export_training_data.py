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

    url = f"{base_url.rstrip('/')}/api/strategies/outcomes"
    response = requests.get(url, params=params, timeout=120)
    response.raise_for_status()
    return pd.read_csv(io.StringIO(response.text))


def load_source_csv(path: Path) -> pd.DataFrame:
    return pd.read_csv(path)


def build_training_frame(raw: pd.DataFrame, recompute: bool = True, version: str = "v1") -> pd.DataFrame:
    row_to_vector = resolve_row_to_vector(version)
    records: list[dict] = []
    skipped_incomplete = 0
    skipped_label = 0

    for _, row in raw.iterrows():
        row_dict = row.to_dict()
        label = read_training_class(row_dict, recompute=recompute)
        if label is None:
            skipped_label += 1
            continue
        features = row_to_vector(row_dict)
        if features is None:
            skipped_incomplete += 1
            continue
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
                **features,
            }
        )

    df = pd.DataFrame(records)
    print(
        f"Built {len(df)} training rows "
        f"(skipped {skipped_label} unlabeled, {skipped_incomplete} incomplete features)"
    )
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
        default=os.environ.get("API_BASE_URL", "http://localhost:3000"),
        help="App base URL for API export",
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
        "--version",
        default="v1",
        choices=["v1", "v2"],
        help="Feature spec version (v2 includes social/telegram features)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Output parquet path (default: data/{version}/training.parquet)",
    )
    args = parser.parse_args()

    if args.output is None:
        args.output = Path("data") / args.version / "training.parquet"

    if args.source == "csv":
        if not args.csv:
            parser.error("--csv required when --source csv")
        raw = load_source_csv(args.csv)
    else:
        raw = fetch_from_api(
            args.api_base,
            args.domain,
            training_class_min=args.training_class_min,
        )

    df = build_training_frame(raw, version=args.version)
    if df.empty:
        raise SystemExit("No training rows — check dataset stats API or CSV filters")

    feature_columns = resolve_feature_columns(args.version)
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
        "version": args.version,
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
