"""Entry-time ML features — mirrors src/strategies/ml-training-features.ts."""

from __future__ import annotations

import math
from typing import Any

ENTRY_MCAP_BANDS = [
    "under50k",
    "51-100k",
    "101-200k",
    "201-500k",
    "501k-1M",
    "over1M",
]

NUMERIC_FEATURES = [
    "log_entry_mcap",
    "organic_score",
    "top_holders_pct",
    "token_age_hours",
    "log_volume_at_entry",
    "entry_template_milestone_80",
]

BAND_FEATURES = [f"band_{band}" for band in ENTRY_MCAP_BANDS]

FEATURE_COLUMNS = NUMERIC_FEATURES + BAND_FEATURES

MIN_LABELED_OUTCOMES = 200

NUM_CLASSES = 5


def compute_training_class(
    pnl_pct: float | None,
    status: str | None,
) -> int | None:
    if pnl_pct is None or not math.isfinite(pnl_pct):
        return None
    is_won = status == "won" or pnl_pct >= 0

    if not is_won or pnl_pct < 0:
        return 0
    if is_won and pnl_pct < 20:
        return 0
    if is_won and pnl_pct < 50:
        return 1
    if pnl_pct < 100:
        return 2
    if pnl_pct < 300:
        return 3
    return 4


def _read_number(row: dict[str, Any], key: str) -> float | None:
    value = row.get(key)
    if value is None or value == "":
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(num):
        return None
    return num


def _log1p(value: float | None) -> float | None:
    if value is None or value < 0:
        return None
    return math.log1p(value)


def _cap_age(hours: float | None) -> float | None:
    if hours is None or hours < 0:
        return None
    return min(hours, 168.0)


def row_to_feature_vector(row: dict[str, Any]) -> dict[str, float] | None:
    """Build feature dict from a CSV/API row (snake_case columns)."""
    log_mcap = _log1p(_read_number(row, "entry_mcap"))
    organic = _read_number(row, "organic_score")
    holders = _read_number(row, "top_holders_pct")
    age = _cap_age(_read_number(row, "token_age_hours"))
    volume = _read_number(row, "volume_at_entry")
    if volume is None:
        volume = _read_number(row, "volume_5m")
    log_vol = _log1p(volume)

    if None in (log_mcap, organic, holders, age, log_vol):
        return None

    template = row.get("entry_template") or ""
    vector: dict[str, float] = {
        "log_entry_mcap": log_mcap,
        "organic_score": organic,
        "top_holders_pct": holders,
        "token_age_hours": age,
        "log_volume_at_entry": log_vol,
        "entry_template_milestone_80": 1.0 if template == "milestone_80" else 0.0,
    }

    band = row.get("entry_mcap_band") or ""
    for band_id in ENTRY_MCAP_BANDS:
        vector[f"band_{band_id}"] = 1.0 if band == band_id else 0.0

    return vector


def read_training_class(row: dict[str, Any], recompute: bool = False) -> int | None:
    if not recompute:
        raw = row.get("training_class")
        if raw is not None and raw != "":
            try:
                value = int(float(raw))
            except (TypeError, ValueError):
                value = None
            if value in (0, 1, 2, 3, 4):
                return value

    pnl = _read_number(row, "pnl_pct")
    status = row.get("status")
    if isinstance(status, float) and math.isnan(status):
        status = None
    if status is not None and not isinstance(status, str):
        status = str(status)
    return compute_training_class(pnl, status)
