"""4-class Sol mcap growth labels for the OHLC second head.

Locked cuts (docs/SPEC-sol-first-spine-4class-ohlc-v1.md):

  loser    growth < 0%
  bep      growth >= 0% and <= 20%   (former unlabeled 0–20% gap)
  winner   growth > 20% and < 120%
  moonbag  growth >= 120%

Binary Pattern (≥120 / <80) is a temporary shadow. This module records that
label beside the 4-class one. It does not replace ``export_pattern_data.py``
or ``train_pattern.py``.
"""

from __future__ import annotations

import json
import math
from typing import Any

GROWTH4_CLASS_NAMES: tuple[str, ...] = ("loser", "bep", "winner", "moonbag")
GROWTH4_CLASS_INDEX: dict[str, int] = {name: i for i, name in enumerate(GROWTH4_CLASS_NAMES)}

# Binary Pattern cohort cuts. Same numbers as classifyMcapPatternCohort
# (winner >= 120, loser < 80, else neutral / not stored).
PATTERN_WINNER_MIN_GROWTH_PCT = 120.0
PATTERN_LOSER_MAX_GROWTH_PCT = 80.0

OHLC_WINDOW = 10

ENTRY_FEATURE_COLUMNS: list[str] = [
    "log_first_mcap",
    "organic_score",
    "organic_score_missing",
    "top_holders_pct",
    "top_holders_pct_missing",
    "log_volume_5m",
    "volume_5m_missing",
]

# Columns that are the label or a function of it. Never model inputs.
LABEL_COLUMNS: tuple[str, ...] = (
    "growth_class",
    "growth_class_name",
    "mcap_growth_percent",
    "pattern_shadow_class",
)

# SPEC READY placeholders. Recorded by the harness. growth4_ready stays false
# in this step: lead-time, calibration, and OOS sleeve beat are not evaluated,
# and nothing here may change paper size.
PLACEHOLDER_MACRO_F1 = 0.40
PLACEHOLDER_PER_CLASS_F1 = 0.25
PLACEHOLDER_TRAIN_N = 1500
PLACEHOLDER_OOS_N = 300
# "n tiny" exclusion for the per-class F1 bar. Same count Pattern already
# requires per class (MIN_PATTERN_ROWS_PER_CLASS). Not a growth cutoff.
TINY_CLASS_SUPPORT = 30

# Local smoke trains below the READY row bar. The check script reports the bar.
MIN_GROWTH4_ROWS = 40

GROWTH4_CUTS: dict[str, str] = {
    "loser": "<0",
    "bep": ">=0 and <=20",
    "winner": ">20 and <120",
    "moonbag": ">=120",
}


def ohlc_feature_columns() -> list[str]:
    cols = ["ohlc_n"]
    for kind in ("ret", "range", "body"):
        for i in range(OHLC_WINDOW):
            cols.append(f"ohlc_{kind}_{i}")
    return cols


def all_feature_columns() -> list[str]:
    return [*ENTRY_FEATURE_COLUMNS, *ohlc_feature_columns()]


def growth_class_name(class_index: int) -> str:
    return GROWTH4_CLASS_NAMES[class_index]


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if text == "" or text.lower() in {"nan", "none", "null"}:
            return None
        value = text
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(num):
        return None
    return num


def growth_class_from_percent(growth: Any) -> int | None:
    """Map mcap growth percent to 0..3. None when growth is missing."""
    g = _as_float(growth)
    if g is None:
        return None
    if g < 0:
        return 0
    if g <= 20:
        return 1
    if g < 120:
        return 2
    return 3


def pattern_shadow_class_from_growth(growth: Any) -> int | None:
    """Binary Pattern shadow on the same growth percent.

    1 = winner (≥120), 0 = loser (<80), None = neutral band that Pattern
    does not store. Does not read or write ``mcap_social_pattern_24h``.
    """
    g = _as_float(growth)
    if g is None:
        return None
    if g >= PATTERN_WINNER_MIN_GROWTH_PCT:
        return 1
    if g < PATTERN_LOSER_MAX_GROWTH_PCT:
        return 0
    return None


def _log1p_nonneg(value: Any) -> float:
    num = _as_float(value)
    if num is None or num < 0:
        return 0.0
    return math.log1p(num)


def entry_features_from_row(row: dict[str, Any]) -> dict[str, float]:
    """Entry-time columns stored on token_mcap_tracking. Not the outcome."""
    organic = _as_float(row.get("organic_score"))
    holders = _as_float(row.get("top_holders_pct"))
    volume = _as_float(row.get("volume_5m"))
    if volume is None:
        volume = _as_float(row.get("log_volume_5m"))
        # Already logged in a hand-built CSV: keep missing flag honest.
        volume_missing = 1.0 if volume is None else 0.0
        log_volume = 0.0 if volume is None else float(volume)
    else:
        volume_missing = 0.0
        log_volume = _log1p_nonneg(volume)

    first_mcap = _as_float(row.get("first_mcap"))
    if first_mcap is None:
        logged = _as_float(row.get("log_first_mcap"))
        log_first = 0.0 if logged is None else logged
    else:
        log_first = _log1p_nonneg(first_mcap)

    return {
        "log_first_mcap": log_first,
        "organic_score": 0.0 if organic is None else organic,
        "organic_score_missing": 1.0 if organic is None else 0.0,
        "top_holders_pct": 0.0 if holders is None else holders,
        "top_holders_pct_missing": 1.0 if holders is None else 0.0,
        "log_volume_5m": log_volume,
        "volume_5m_missing": volume_missing,
    }


def parse_ohlc_bars(raw: Any) -> list[dict[str, float]]:
    """Last ≤10 finite 1m bars, oldest → newest. Empty when unusable."""
    if raw is None:
        return []
    if isinstance(raw, str):
        text = raw.strip()
        if text == "" or text.lower() in {"null", "none", "nan"}:
            return []
        try:
            raw = json.loads(text)
        except json.JSONDecodeError:
            return []
    if not isinstance(raw, list):
        return []

    bars: list[dict[str, float]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        t_raw = item.get("t", item.get("time"))
        try:
            t = float(t_raw) if t_raw is not None else float("nan")
            o = float(item["o"])
            h = float(item["h"])
            low = float(item["l"])
            c = float(item["c"])
        except (TypeError, ValueError, KeyError):
            continue
        if not all(math.isfinite(x) for x in (t, o, h, low, c)):
            continue
        if o <= 0 or c <= 0:
            continue
        bars.append({"t": t, "o": o, "h": h, "l": low, "c": c})
    bars.sort(key=lambda b: b["t"])
    if len(bars) > OHLC_WINDOW:
        bars = bars[-OHLC_WINDOW:]
    return bars


def ohlc_window_features(raw: Any) -> dict[str, float]:
    """Fixed ≤10 bar vector. Index 9 is the last bar; shorter windows pad left.

    Returns are log(close / first close in the kept window), so the level of
    the token's price is not a feature. ``ohlc_n`` is 0 when no usable bar.
    """
    bars = parse_ohlc_bars(raw)
    n = len(bars)
    padded: list[dict[str, float] | None] = [None] * (OHLC_WINDOW - n) + bars
    anchor = bars[0]["c"] if bars else None
    feats: dict[str, float] = {"ohlc_n": float(n)}
    for i, bar in enumerate(padded):
        if bar is None or anchor is None or anchor <= 0:
            feats[f"ohlc_ret_{i}"] = 0.0
            feats[f"ohlc_range_{i}"] = 0.0
            feats[f"ohlc_body_{i}"] = 0.0
            continue
        feats[f"ohlc_ret_{i}"] = math.log(bar["c"] / anchor)
        feats[f"ohlc_range_{i}"] = (bar["h"] - bar["l"]) / bar["c"]
        feats[f"ohlc_body_{i}"] = (bar["c"] - bar["o"]) / bar["o"]
    return feats


def empty_ohlc_features() -> dict[str, float]:
    return ohlc_window_features([])


def resolve_feature_columns(mode: str, columns: list[str], ohlc_present: bool) -> list[str]:
    """``auto`` uses OHLC + entry when any exported row has bars, else entry."""
    if mode == "auto":
        mode = "all" if ohlc_present else "entry"
    if mode == "entry":
        chosen = list(ENTRY_FEATURE_COLUMNS)
    elif mode == "ohlc":
        chosen = ohlc_feature_columns()
    elif mode == "all":
        chosen = all_feature_columns()
    else:
        raise SystemExit(f"Unknown --features {mode!r} (entry, ohlc, all, auto)")
    missing = [c for c in chosen if c not in columns]
    if missing:
        raise SystemExit(f"Missing feature columns: {missing}")
    leaked = [c for c in chosen if c in LABEL_COLUMNS]
    if leaked:
        raise SystemExit(f"Refusing label columns as features: {leaked}")
    return chosen


def format_shadow_log(
    probs: dict[str, float],
    predicted: str,
    token: str | None = None,
) -> str:
    """One shadow line. Paper size is off; this only logs the four probabilities."""
    parts = ["growth4 shadow"]
    if token:
        parts.append(f"token={token}")
    for name in GROWTH4_CLASS_NAMES:
        parts.append(f"p_{name}={probs[name]:.4f}")
    parts.append(f"predicted={predicted}")
    parts.append("serve=shadow")
    parts.append("paper_size=off")
    return " ".join(parts)


def probs_from_row(values: Any) -> dict[str, float]:
    """Normalize a length-4 probability vector into named class probs."""
    try:
        raw = [float(v) for v in list(values)]
    except (TypeError, ValueError) as exc:
        raise ValueError("expected 4 class probabilities") from exc
    if len(raw) != len(GROWTH4_CLASS_NAMES):
        raise ValueError(f"expected {len(GROWTH4_CLASS_NAMES)} class probabilities, got {len(raw)}")
    clipped = [v if math.isfinite(v) and v > 0 else 0.0 for v in raw]
    total = sum(clipped)
    if total <= 0:
        share = 1.0 / len(GROWTH4_CLASS_NAMES)
        clipped = [share] * len(GROWTH4_CLASS_NAMES)
    else:
        clipped = [v / total for v in clipped]
    return {name: clipped[i] for i, name in enumerate(GROWTH4_CLASS_NAMES)}
