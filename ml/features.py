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

SOCIAL_FEATURES = [
    "log_telegram_mention_count_30m",
    "telegram_unique_channels_30m",
    "minutes_since_first_mention",
    "smart_wallet_buy_count_1h",
    "has_smart_wallet_buy",
]

BAND_FEATURES = [f"band_{band}" for band in ENTRY_MCAP_BANDS]

FEATURE_COLUMNS = NUMERIC_FEATURES + BAND_FEATURES

FEATURE_COLUMNS_V2 = FEATURE_COLUMNS + SOCIAL_FEATURES

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


def compute_gate_class(
    pnl_pct: float | None,
    status: str | None,
) -> int | None:
    training_class = compute_training_class(pnl_pct, status)
    if training_class is None:
        return None
    return 0 if training_class == 0 else 1


def compute_potential_tier(
    pnl_pct: float | None,
    status: str | None,
) -> int | None:
    training_class = compute_training_class(pnl_pct, status)
    if training_class is None or training_class == 0:
        return None
    return training_class


def gate_class_from_training_class(training_class: int | None) -> int | None:
    if training_class is None:
        return None
    return 0 if training_class == 0 else 1


def potential_tier_from_training_class(training_class: int | None) -> int | None:
    if training_class is None or training_class == 0:
        return None
    return training_class


MIN_POTENTIAL_OUTCOMES = 30


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


def _derive_token_age_hours(row: dict[str, Any]) -> float | None:
    """Mirror TS computeTokenAgeHours(entry_at, first_seen_at)."""
    entry_raw = row.get("entry_at")
    first_raw = row.get("first_seen_at")
    if not entry_raw or not first_raw:
        return None
    try:
        from datetime import datetime

        def _parse(iso: Any) -> float | None:
            if not isinstance(iso, str) or not iso.strip():
                return None
            text = iso.strip().replace("Z", "+00:00")
            return datetime.fromisoformat(text).timestamp()

        entry_ts = _parse(entry_raw)
        first_ts = _parse(first_raw)
        if entry_ts is None or first_ts is None:
            return None
        diff = entry_ts - first_ts
        if diff < 0:
            return 0.0
        return round((diff / 3600.0) * 100) / 100
    except (TypeError, ValueError, OSError):
        return None


def canonicalize_row(row: dict[str, Any]) -> dict[str, Any]:
    """Apply aliases + age derive so Python export matches TS toCanonicalEntryFeatures."""
    out = dict(row)
    if _read_number(out, "entry_mcap") is None:
        first_mcap = _read_number(out, "first_mcap")
        if first_mcap is not None:
            out["entry_mcap"] = first_mcap
    if _read_number(out, "volume_at_entry") is None:
        vol5 = _read_number(out, "volume_5m")
        if vol5 is not None:
            out["volume_at_entry"] = vol5
    if _read_number(out, "token_age_hours") is None:
        derived = _derive_token_age_hours(out)
        if derived is not None:
            out["token_age_hours"] = derived
    # Social aliases (Pattern / gate dual-write)
    if _read_number(out, "telegram_mention_count_30m") is None:
        mentions = _read_number(out, "mention_count_30m")
        if mentions is not None:
            out["telegram_mention_count_30m"] = mentions
    if _read_number(out, "minutes_since_first_mention") is None:
        mins = _read_number(out, "minutes_to_first_mention")
        if mins is not None:
            out["minutes_since_first_mention"] = mins
    return out


def _cap_minutes(minutes: float | None) -> float:
    if minutes is None or minutes < 0:
        return 0.0
    return min(minutes, 720.0)


def _read_social_features(row: dict[str, Any]) -> dict[str, float]:
    mentions = _read_number(row, "telegram_mention_count_30m") or 0.0
    channels = _read_number(row, "telegram_unique_channels_30m") or 0.0
    minutes = _cap_minutes(_read_number(row, "minutes_since_first_mention"))
    wallet_buys = _read_number(row, "smart_wallet_buy_count_1h") or 0.0
    has_wallet_raw = row.get("has_smart_wallet_buy")
    has_wallet = 1.0 if has_wallet_raw is True or wallet_buys > 0 else 0.0
    return {
        "log_telegram_mention_count_30m": _log1p(mentions) or 0.0,
        "telegram_unique_channels_30m": channels,
        "minutes_since_first_mention": minutes,
        "smart_wallet_buy_count_1h": wallet_buys,
        "has_smart_wallet_buy": has_wallet,
    }


def row_to_feature_vector(row: dict[str, Any]) -> dict[str, float] | None:
    """Build v1 feature dict from a CSV/API row (snake_case columns)."""
    return row_to_feature_vector_v1(row)


def row_to_feature_vector_v1(row: dict[str, Any]) -> dict[str, float] | None:
    row = canonicalize_row(row)
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


def row_to_feature_vector_v2(row: dict[str, Any]) -> dict[str, float] | None:
    base = row_to_feature_vector_v1(row)
    if base is None:
        return None
    base.update(_read_social_features(row))
    return base


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
