"""Pattern ML features — mirrors src/strategies/social/pattern-features.ts."""

from __future__ import annotations

import math
from typing import Any

PATTERN_TOP_SOURCE_GMGN_FOMO = "GMGN_Smart_Money_FOMO"

PATTERN_FEATURE_COLUMNS = [
    "log_first_mcap",
    "log_mention_count_30m",
    "unique_channels_30m",
    "minutes_to_first_mention",
    "smart_wallet_buy_count_1h",
    "has_smart_wallet_buy",
    "source_gmgn_smart_money_fomo",
]

MIN_PATTERN_ROWS = 60
MIN_PATTERN_ROWS_PER_CLASS = 30
MIN_PATTERN_MACRO_F1 = 0.60

WINDOW_30M_MS = 30 * 60 * 1000
WINDOW_1H_MS = 60 * 60 * 1000


def _read_number(value: Any) -> float | None:
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


def _cap_minutes(minutes: float | None) -> float:
    if minutes is None or minutes < 0 or not math.isfinite(minutes):
        return 0.0
    return min(minutes, 720.0)


def _parse_events(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    return [e for e in raw if isinstance(e, dict)]


def _event_ms(event: dict[str, Any]) -> float | None:
    iso = event.get("occurred_at")
    if not iso:
        return None
    try:
        import pandas as pd

        ms = pd.Timestamp(iso).timestamp() * 1000
    except Exception:
        return None
    return ms if math.isfinite(ms) else None


def social_metrics_from_events(events: list[dict[str, Any]], first_seen_ms: float) -> dict[str, float | bool]:
    channels: set[str] = set()
    mention_count_30m = 0
    wallet_buy_count_1h = 0
    first_mention_ms: float | None = None
    has_gmgn_fomo = False

    for event in events:
        ms = _event_ms(event)
        if ms is None:
            continue
        delta = ms - first_seen_ms
        if delta < 0:
            continue

        event_type = str(event.get("event_type") or "")
        if event_type == "mention" and delta <= WINDOW_30M_MS:
            mention_count_30m += 1
            channel = str(event.get("channel_id") or "")
            if channel:
                channels.add(channel)
            if str(event.get("source") or "") == PATTERN_TOP_SOURCE_GMGN_FOMO:
                has_gmgn_fomo = True
            if first_mention_ms is None or ms < first_mention_ms:
                first_mention_ms = ms

        if event_type == "wallet_buy" and delta <= WINDOW_1H_MS:
            wallet_buy_count_1h += 1

    if first_mention_ms is None:
        minutes_to_first = 720.0
    else:
        minutes_to_first = _cap_minutes((first_mention_ms - first_seen_ms) / (60 * 1000))

    return {
        "mention_count_30m": float(mention_count_30m),
        "unique_channels_30m": float(len(channels)),
        "minutes_to_first_mention": minutes_to_first,
        "wallet_buy_count_1h": float(wallet_buy_count_1h),
        "has_gmgn_fomo": has_gmgn_fomo,
    }


def build_pattern_feature_vector(params: dict[str, float | bool]) -> dict[str, float] | None:
    log_first = _log1p(_read_number(params.get("first_mcap")))
    if log_first is None:
        return None

    mention_count = float(params.get("mention_count_30m") or 0)
    wallet_buys = float(params.get("wallet_buy_count_1h") or 0)
    has_gmgn = bool(params.get("has_gmgn_fomo"))

    return {
        "log_first_mcap": log_first,
        "log_mention_count_30m": _log1p(mention_count) or 0.0,
        "unique_channels_30m": float(params.get("unique_channels_30m") or 0),
        "minutes_to_first_mention": _cap_minutes(_read_number(params.get("minutes_to_first_mention"))),
        "smart_wallet_buy_count_1h": wallet_buys,
        "has_smart_wallet_buy": 1.0 if wallet_buys > 0 else 0.0,
        "source_gmgn_smart_money_fomo": 1.0 if has_gmgn else 0.0,
    }


def row_to_pattern_features(row: dict[str, Any]) -> dict[str, float] | None:
    """Build features from flattened CSV/API export row."""
    first_mcap = _read_number(row.get("first_mcap"))
    if first_mcap is None:
        first_mcap = _read_number(row.get("log_first_mcap"))
        if first_mcap is not None and first_mcap > 0:
            first_mcap = math.expm1(first_mcap)

    if first_mcap is None:
        return None

    if all(k in row for k in PATTERN_FEATURE_COLUMNS):
        vector: dict[str, float] = {}
        for key in PATTERN_FEATURE_COLUMNS:
            num = _read_number(row.get(key))
            vector[key] = 0.0 if num is None else num
        return vector

    return build_pattern_feature_vector(
        {
            "first_mcap": first_mcap,
            "mention_count_30m": _read_number(row.get("mention_count_30m")) or 0,
            "unique_channels_30m": _read_number(row.get("unique_channels_30m")) or 0,
            "minutes_to_first_mention": _read_number(row.get("minutes_to_first_mention")) or 720,
            "wallet_buy_count_1h": _read_number(row.get("smart_wallet_buy_count_1h")) or 0,
            "has_gmgn_fomo": row.get("source_gmgn_smart_money_fomo") in (1, 1.0, True, "1"),
        }
    )


def pattern_class_from_cohort(cohort: str | None) -> int | None:
    if cohort == "winner":
        return 1
    if cohort == "loser":
        return 0
    return None
