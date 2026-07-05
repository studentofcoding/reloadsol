#!/usr/bin/env python3
"""Export 24h pattern cohort data for pattern-gate training."""

from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path

import pandas as pd
import requests

from pattern_features import PATTERN_FEATURE_COLUMNS, pattern_class_from_cohort


def fetch_from_api(base_url: str, secret: str | None) -> pd.DataFrame:
    params: dict[str, str] = {"format": "json"}
    if secret:
        params["key"] = secret
    url = f"{base_url.rstrip('/')}/api/mcap-patterns/training-export"
    response = requests.get(url, params=params, timeout=120)
    response.raise_for_status()
    payload = response.json()
    rows = payload.get("rows") or []
    return pd.DataFrame(rows)


def load_source_csv(path: Path) -> pd.DataFrame:
    return pd.read_csv(path)


def build_training_frame(raw: pd.DataFrame) -> pd.DataFrame:
    if raw.empty:
        return raw

    if "pattern_class" not in raw.columns and "cohort" in raw.columns:
        raw = raw.copy()
        raw["pattern_class"] = raw["cohort"].map(pattern_class_from_cohort)

    missing = [c for c in PATTERN_FEATURE_COLUMNS if c not in raw.columns]
    if missing:
        raise SystemExit(f"Missing feature columns in export: {missing}")

    df = raw.dropna(subset=["pattern_class"]).copy()
    df["pattern_class"] = df["pattern_class"].astype(int)
    return df


def main() -> None:
    parser = argparse.ArgumentParser(description="Export pattern ML training dataset")
    parser.add_argument(
        "--source",
        choices=["api", "csv"],
        default="api",
        help="Data source (default: api)",
    )
    parser.add_argument("--csv", type=Path, help="Local CSV when --source csv")
    parser.add_argument(
        "--api-base",
        default=os.environ.get("API_BASE_URL", "http://127.0.0.1"),
        help="App base URL (prod host: http://127.0.0.1 via nginx)",
    )
    parser.add_argument(
        "--secret",
        default=os.environ.get("TRENDING_TRACKER_SECRET"),
        help="Rollup/training export secret",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/pattern/training.parquet"),
        help="Output parquet path",
    )
    args = parser.parse_args()

    if args.source == "csv":
        if not args.csv:
            parser.error("--csv required when --source csv")
        raw = load_source_csv(args.csv)
    else:
        raw = fetch_from_api(args.api_base, args.secret)

    df = build_training_frame(raw)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(args.output, index=False)

    manifest = {
        "row_count": len(df),
        "by_cohort": (
            df["cohort"].value_counts().to_dict() if "cohort" in df.columns else {}
        ),
        "by_pattern_class": df["pattern_class"].value_counts().to_dict(),
        "feature_columns": PATTERN_FEATURE_COLUMNS,
        "output": str(args.output),
    }
    manifest_path = args.output.with_name("dataset_manifest.json")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

    print(f"Exported {len(df)} rows to {args.output}")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
