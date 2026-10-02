#!/usr/bin/env python3
"""Export 4-class growth labels for every Sol token_mcap_tracking row.

Source of truth is ``mcap_growth_percent`` (research #80). The former 0–20%
gap is class ``bep``. Binary Pattern is copied onto ``pattern_shadow_class``
for comparison; ``ml:export-patterns`` is unchanged.

  cd ml
  python3 export_growth4_data.py --output data/growth4/training.parquet
  python3 export_growth4_data.py --source csv --csv rows.csv --output /tmp/growth4.parquet
"""

from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import subprocess
import urllib.parse
from pathlib import Path
from typing import Any

import pandas as pd

from growth4 import (
    ENTRY_FEATURE_COLUMNS,
    GROWTH4_CLASS_NAMES,
    GROWTH4_CUTS,
    entry_features_from_row,
    growth_class_from_percent,
    growth_class_name,
    ohlc_feature_columns,
    ohlc_window_features,
    pattern_shadow_class_from_growth,
)

MCAP_COPY_SQL = """
COPY (
  SELECT
    token_address,
    chain,
    token_symbol,
    first_mcap,
    first_seen_at,
    mcap_growth_percent,
    organic_score,
    top_holders_pct,
    volume_5m
  FROM token_mcap_tracking
  WHERE chain = 'sol'
    AND mcap_growth_percent IS NOT NULL
) TO STDOUT WITH (FORMAT csv, HEADER true)
""".strip()

OHLC_COPY_SQL = """
COPY (
  SELECT s.token_address, s.bars::text AS bars
  FROM (
    SELECT DISTINCT ON (token_address)
      token_address,
      bars
    FROM signal_ohlc_labels
    WHERE ohlc_interval = '1m'
      AND jsonb_typeof(bars) = 'array'
      AND jsonb_array_length(bars) > 0
    ORDER BY token_address, jsonb_array_length(bars) DESC, created_at DESC
  ) s
  INNER JOIN token_mcap_tracking t
    ON t.token_address = s.token_address
   AND t.chain = 'sol'
) TO STDOUT WITH (FORMAT csv, HEADER true)
""".strip()


def _load_env_file(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, val = stripped.partition("=")
        key = key.strip()
        if key not in ("DATABASE_URL", "DATABASE_URL_DIRECT"):
            continue
        if os.environ.get(key, "").strip():
            continue
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in {'"', "'"}:
            val = val[1:-1]
        if val:
            os.environ[key] = val


def resolve_database_url(explicit: str | None = None) -> str:
    if explicit and explicit.strip():
        url = explicit.strip()
    else:
        root = Path(__file__).resolve().parents[1]
        _load_env_file(root / ".env.local")
        _load_env_file(root / ".env")
        url = os.environ.get("DATABASE_URL_DIRECT", "").strip() or os.environ.get(
            "DATABASE_URL", ""
        ).strip()
    if not url:
        raise SystemExit(
            "Set DATABASE_URL or DATABASE_URL_DIRECT "
            "(host: scripts/train-closed-loop-ml.ts rewrites reloadsol-db the same way)"
        )
    if "reloadsol-db" in url or "reloadsol-bouncer" in url:
        parsed = urllib.parse.urlsplit(url)
        host = parsed.hostname or ""
        if host in {"reloadsol-db", "reloadsol-bouncer"}:
            netloc = parsed.netloc.replace(host, "127.0.0.1", 1)
            parsed = parsed._replace(netloc=netloc)
            url = urllib.parse.urlunsplit(parsed)
    return url


def _redact(message: str, url: str) -> str:
    if url and url in message:
        message = message.replace(url, "DATABASE_URL")
    password = urllib.parse.urlsplit(url).password if url else None
    if password:
        message = message.replace(urllib.parse.unquote(password), "***")
    return message


# libpq URL query params we forward as PG* env vars. Anything else is refused
# rather than silently dropped.
_PG_QUERY_ENV = {
    "sslmode": "PGSSLMODE",
    "sslrootcert": "PGSSLROOTCERT",
    "sslcert": "PGSSLCERT",
    "sslkey": "PGSSLKEY",
    "application_name": "PGAPPNAME",
    "connect_timeout": "PGCONNECT_TIMEOUT",
}


def pg_env_from_url(database_url: str, base: dict[str, str] | None = None) -> dict[str, str]:
    """Connection settings as PG* env vars, so the URL and password never appear
    in psql's argv (visible in ``ps`` and shell history)."""
    parsed = urllib.parse.urlsplit(database_url)
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise SystemExit("DATABASE_URL must be a postgres:// or postgresql:// URL")
    env = dict(os.environ if base is None else base)
    env.setdefault("PGCONNECT_TIMEOUT", "15")
    if parsed.hostname:
        env["PGHOST"] = parsed.hostname
    if parsed.port:
        env["PGPORT"] = str(parsed.port)
    if parsed.username:
        env["PGUSER"] = urllib.parse.unquote(parsed.username)
    if parsed.password:
        env["PGPASSWORD"] = urllib.parse.unquote(parsed.password)
    dbname = urllib.parse.unquote(parsed.path.lstrip("/"))
    if dbname:
        env["PGDATABASE"] = dbname
    for key, values in urllib.parse.parse_qs(parsed.query).items():
        target = _PG_QUERY_ENV.get(key)
        if target is None:
            raise SystemExit(f"Unsupported DATABASE_URL query parameter {key!r}")
        env[target] = values[-1]
    return env


def psql_copy(database_url: str, sql: str) -> str:
    if shutil.which("psql") is None:
        raise SystemExit("psql not found — install the Postgres client, or pass --source csv")
    env = pg_env_from_url(database_url)
    proc = subprocess.run(
        ["psql", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )
    if proc.returncode != 0:
        err = _redact((proc.stderr or proc.stdout or "psql failed").strip(), database_url)
        raise SystemExit(f"psql COPY failed: {err}")
    return proc.stdout


def fetch_mcap_frame(database_url: str) -> pd.DataFrame:
    raw = psql_copy(database_url, MCAP_COPY_SQL)
    return pd.read_csv(io.StringIO(raw))


def fetch_ohlc_bars(database_url: str) -> pd.DataFrame | None:
    try:
        raw = psql_copy(database_url, OHLC_COPY_SQL)
    except SystemExit as exc:
        print(f"WARNING: OHLC bar join skipped ({exc})")
        return None
    if not raw.strip():
        return pd.DataFrame(columns=["token_address", "bars"])
    return pd.read_csv(io.StringIO(raw))


def build_growth4_frame(
    raw: pd.DataFrame,
    *,
    with_ohlc: bool,
    bars_by_address: dict[str, Any] | None = None,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Label every finite-growth Sol row. Drop null growth. Do not drop 0–20%."""
    stats: dict[str, Any] = {
        "input_rows": int(len(raw)),
        "skipped_non_sol": 0,
        "skipped_no_address": 0,
        "skipped_unlabeled": 0,
        "ohlc_rows": 0,
    }
    if raw.empty:
        return raw, stats

    df = raw.copy()
    if "chain" in df.columns:
        chain = df["chain"].fillna("sol").astype(str).str.strip().str.lower()
        stats["skipped_non_sol"] = int((chain != "sol").sum())
        df = df.loc[chain == "sol"].copy()

    records: list[dict[str, Any]] = []
    ohlc_cols = ohlc_feature_columns() if with_ohlc else []
    for row in df.to_dict(orient="records"):
        address = str(row.get("token_address") or "").strip()
        if not address or address.lower() == "nan":
            stats["skipped_no_address"] += 1
            continue
        growth = row.get("mcap_growth_percent")
        label = growth_class_from_percent(growth)
        if label is None:
            stats["skipped_unlabeled"] += 1
            continue
        features = entry_features_from_row(row)
        bars_raw = None
        if with_ohlc:
            if bars_by_address is not None:
                bars_raw = bars_by_address.get(address)
            if bars_raw is None and "bars" in row:
                bars_raw = row.get("bars")
            ohlc = ohlc_window_features(bars_raw)
            if ohlc["ohlc_n"] > 0:
                stats["ohlc_rows"] += 1
        else:
            ohlc = {}
        shadow = pattern_shadow_class_from_growth(growth)
        records.append(
            {
                "token_address": address,
                "chain": "sol",
                "token_symbol": row.get("token_symbol"),
                "first_seen_at": row.get("first_seen_at"),
                "mcap_growth_percent": float(growth),
                "growth_class": label,
                "growth_class_name": growth_class_name(label),
                "pattern_shadow_class": shadow,
                "ohlc_clock": "label_capture" if ohlc.get("ohlc_n", 0) > 0 else "none",
                **features,
                **ohlc,
            }
        )

    out = pd.DataFrame.from_records(records)
    if out.empty:
        return out, stats
    front = [
        "token_address",
        "chain",
        "token_symbol",
        "first_seen_at",
        "mcap_growth_percent",
        "growth_class",
        "growth_class_name",
        "pattern_shadow_class",
        "ohlc_clock",
    ]
    ordered = [c for c in front if c in out.columns]
    ordered += [c for c in ENTRY_FEATURE_COLUMNS if c in out.columns]
    ordered += [c for c in ohlc_cols if c in out.columns]
    return out[ordered], stats


def _class_counts(df: pd.DataFrame) -> dict[str, int]:
    if df.empty or "growth_class_name" not in df.columns:
        return {name: 0 for name in GROWTH4_CLASS_NAMES}
    counts = df["growth_class_name"].value_counts().to_dict()
    return {name: int(counts.get(name, 0)) for name in GROWTH4_CLASS_NAMES}


def _pattern_shadow_counts(df: pd.DataFrame) -> dict[str, int]:
    if df.empty or "pattern_shadow_class" not in df.columns:
        return {"0": 0, "1": 0, "neutral": 0}
    series = df["pattern_shadow_class"]
    neutral = int(series.isna().sum())
    zeros = int((series == 0).sum())
    ones = int((series == 1).sum())
    return {"0": zeros, "1": ones, "neutral": neutral}


def main() -> None:
    parser = argparse.ArgumentParser(description="Export 4-class Sol mcap growth labels")
    parser.add_argument("--source", choices=["db", "csv"], default="db")
    parser.add_argument("--csv", type=Path, help="CSV when --source csv")
    parser.add_argument(
        "--database-url",
        default=None,
        help="Postgres URL (default: DATABASE_URL_DIRECT or DATABASE_URL)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/growth4/training.parquet"),
        help="Output parquet path",
    )
    parser.add_argument(
        "--no-ohlc",
        action="store_true",
        help="Skip signal_ohlc_labels join (entry features + labels only)",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Print one summary line (manifest is still written)",
    )
    args = parser.parse_args()

    with_ohlc = not args.no_ohlc
    bars_by_address: dict[str, Any] | None = None
    ohlc_clock = "none"

    if args.source == "csv":
        if not args.csv:
            parser.error("--csv required when --source csv")
        raw = pd.read_csv(args.csv)
        if with_ohlc and "bars" not in raw.columns:
            print("WARNING: --source csv has no bars column; OHLC features will be zeros")
            ohlc_clock = "none"
        elif with_ohlc:
            ohlc_clock = "label_capture"
    else:
        database_url = resolve_database_url(args.database_url)
        raw = fetch_mcap_frame(database_url)
        if with_ohlc:
            ohlc = fetch_ohlc_bars(database_url)
            if ohlc is None:
                with_ohlc = False
            else:
                bars_by_address = {
                    str(addr): bars
                    for addr, bars in zip(ohlc["token_address"], ohlc["bars"], strict=False)
                }
                ohlc_clock = "label_capture"

    df, stats = build_growth4_frame(raw, with_ohlc=with_ohlc, bars_by_address=bars_by_address)
    if int(stats["ohlc_rows"]) == 0:
        ohlc_clock = "none"
    if df.empty:
        raise SystemExit("No labeled Sol rows — check chain=sol and mcap_growth_percent")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(args.output, index=False)

    manifest = {
        "label": "growth4",
        "chain": "sol",
        "label_source": "token_mcap_tracking.mcap_growth_percent",
        "cuts": GROWTH4_CUTS,
        "row_count": int(len(df)),
        "by_growth_class": _class_counts(df),
        "by_pattern_shadow_class": _pattern_shadow_counts(df),
        "pattern_shadow": (
            "Binary Pattern (>=120 → 1, <80 → 0, else neutral) on the same growth. "
            "ml/export_pattern_data.py and ml/train_pattern.py are unchanged."
        ),
        "ohlc_rows": int(stats["ohlc_rows"]),
        "ohlc_clock": ohlc_clock if with_ohlc else "none",
        "ohlc_clock_note": (
            "Bars come from signal_ohlc_labels (label/detect capture, longest 1m set). "
            "Not as-of first_seen. first_seen as-of train stays blocked (research #81)."
        ),
        "skipped_non_sol": int(stats["skipped_non_sol"]),
        "skipped_unlabeled": int(stats["skipped_unlabeled"]),
        "skipped_no_address": int(stats["skipped_no_address"]),
        "entry_feature_columns": [c for c in ENTRY_FEATURE_COLUMNS if c in df.columns],
        "ohlc_feature_columns": [c for c in ohlc_feature_columns() if c in df.columns],
        "output": str(args.output),
    }
    manifest_path = args.output.with_name("dataset_manifest.json")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

    counts = manifest["by_growth_class"]
    summary = (
        f"Exported {len(df)} Sol rows → {args.output} "
        f"loser={counts['loser']} bep={counts['bep']} "
        f"winner={counts['winner']} moonbag={counts['moonbag']} "
        f"ohlc_rows={stats['ohlc_rows']}"
    )
    if args.quiet:
        print(summary)
    else:
        print(summary)
        print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
