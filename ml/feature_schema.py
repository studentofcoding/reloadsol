"""Loads ``ml/feature-schema.json`` — the committed mirror of ``src/strategies/feature-registry.ts``.

The single source of truth is the TS registry. This module is how Python reads it, so the
constants in ``features.py`` / ``pattern_features.py`` derive from here instead of being
hand-maintained a second time. Regenerate the mirror with::

    npm run ml:export-schema

Override the path with ``ML_FEATURE_SCHEMA_PATH`` (tests).
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

DEFAULT_SCHEMA_PATH = Path(__file__).resolve().parent / "feature-schema.json"


def _schema_path() -> Path:
    override = os.environ.get("ML_FEATURE_SCHEMA_PATH", "").strip()
    return Path(override) if override else DEFAULT_SCHEMA_PATH


@lru_cache(maxsize=1)
def load_schema() -> dict:
    with _schema_path().open("r", encoding="utf-8") as handle:
        return json.load(handle)


def schema_version() -> int:
    return int(load_schema()["version"])


def stage_columns(stage: str, set_name: str = "default") -> list[str]:
    """Ordered column list for a stage/set. Raises rather than guessing at an unknown name."""
    stages = load_schema()["stages"]
    if stage not in stages:
        raise KeyError(f"unknown feature stage {stage!r} (have {sorted(stages)})")
    sets = stages[stage]
    if set_name not in sets:
        raise KeyError(f"unknown column set {stage}.{set_name} (have {sorted(sets)})")
    return list(sets[set_name])
