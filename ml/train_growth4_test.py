#!/usr/bin/env python3
"""Offline export + train/eval + shadow predict on a synthetic Sol frame."""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from export_growth4_data import build_growth4_frame
from growth4 import (
    ENTRY_FEATURE_COLUMNS,
    GROWTH4_CLASS_NAMES,
    LABEL_COLUMNS,
    ohlc_feature_columns,
)
from unittest import mock

import export_growth4_data
from export_growth4_data import pg_env_from_url, psql_copy
from predict_growth4 import load_model, predict_probs, vector_from_row
from train_growth4 import (
    _class_weight_map,
    carve_valid,
    time_split,
    train_growth4,
)


def synthetic_raw() -> pd.DataFrame:
    """Interleaved classes so a time split still sees all four."""
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    bands = [-15.0, 0.0, 10.0, 20.0, 50.0, 80.0, 119.0, 120.0, 240.0]
    # Repeat a balanced core so each class has enough rows.
    core = [-12.0, 5.0, 40.0, 180.0]
    growths = core * 24 + bands
    rows = []
    for i, growth in enumerate(growths):
        rows.append(
            {
                "token_address": f"mint{i}",
                "chain": "sol" if i % 17 else "robinhood",
                "token_symbol": "T",
                "first_seen_at": (start + timedelta(hours=i)).isoformat(),
                "first_mcap": 30_000 + i * 10,
                "mcap_growth_percent": growth,
                "organic_score": 10 + (i % 5),
                "top_holders_pct": 15.0,
                "volume_5m": 1_000 + i,
                "bars": json.dumps(
                    [
                        {"t": 1, "o": 1.0, "h": 1.2, "l": 0.9, "c": 1.0},
                        {"t": 2, "o": 1.0, "h": 1.3, "l": 0.8, "c": 1.0 + (i % 5) * 0.01},
                    ]
                ),
            }
        )
    rows.append(
        {
            "token_address": "nolabel",
            "chain": "sol",
            "first_seen_at": start.isoformat(),
            "first_mcap": 1,
            "mcap_growth_percent": None,
            "organic_score": 1,
            "top_holders_pct": 1,
            "volume_5m": 1,
        }
    )
    return pd.DataFrame(rows)


class Growth4HarnessTest(unittest.TestCase):
    def test_export_keeps_bep_and_drops_non_sol(self) -> None:
        frame, stats = build_growth4_frame(synthetic_raw(), with_ohlc=True)
        self.assertGreater(stats["skipped_non_sol"], 0)
        self.assertGreater(stats["skipped_unlabeled"], 0)
        self.assertGreater(int((frame["growth_class_name"] == "bep").sum()), 0)
        self.assertEqual(set(frame["growth_class_name"].unique()), set(GROWTH4_CLASS_NAMES))
        self.assertNotIn("robinhood", set(frame["chain"]))
        self.assertTrue(set(LABEL_COLUMNS).isdisjoint(ENTRY_FEATURE_COLUMNS))
        for col in LABEL_COLUMNS:
            self.assertNotIn(col, ENTRY_FEATURE_COLUMNS)
        self.assertIn("mcap_growth_percent", frame.columns)
        self.assertGreater(int((frame["ohlc_n"] > 0).sum()), 0)
        # 0% and 20% stay bep; 120% is moonbag; 80% is winner and Pattern-neutral.
        by_growth = dict(zip(frame["mcap_growth_percent"], frame["growth_class_name"], strict=False))
        self.assertEqual(by_growth[0.0], "bep")
        self.assertEqual(by_growth[20.0], "bep")
        self.assertEqual(by_growth[120.0], "moonbag")
        self.assertEqual(by_growth[80.0], "winner")
        neutral = frame.loc[frame["mcap_growth_percent"] == 80.0, "pattern_shadow_class"]
        self.assertTrue(neutral.isna().all())

    def test_train_holdout_metrics_and_shadow_predict(self) -> None:
        frame, _stats = build_growth4_frame(synthetic_raw(), with_ohlc=True)
        feature_columns = [
            c for c in [*ENTRY_FEATURE_COLUMNS, *ohlc_feature_columns()] if c in frame.columns
        ]
        booster, train_df, valid_df, test_df, meta = train_growth4(
            frame,
            feature_columns,
            test_ratio=0.2,
            min_rows=40,
            num_boost_round=20,
        )
        self.assertGreater(len(test_df), 0)
        self.assertGreater(len(valid_df), 0)
        self.assertFalse(meta["metrics"]["growth4_ready"])
        self.assertFalse(meta["wired_to_paper_size"])
        self.assertEqual(meta["serve_mode"], "shadow")
        self.assertEqual(set(meta["metrics"]["per_class"]), set(GROWTH4_CLASS_NAMES))
        self.assertIsInstance(meta["metrics"]["macro_f1"], float)
        # Holdout is the later slice.
        self.assertLessEqual(
            pd.to_datetime(train_df["first_seen_at"], utc=True).max(),
            pd.to_datetime(test_df["first_seen_at"], utc=True).min(),
        )

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            booster.save_model(str(out / "model.lgb.txt"))
            payload = {
                "feature_columns": feature_columns,
                "wired_to_paper_size": False,
                "serve_mode": "shadow",
            }
            (out / "model.meta.json").write_text(json.dumps(payload))
            loaded, cols = load_model(out)
            row = frame.iloc[0].to_dict()
            probs, predicted = predict_probs(loaded, cols, row)
            self.assertEqual(set(probs), set(GROWTH4_CLASS_NAMES))
            self.assertAlmostEqual(sum(probs.values()), 1.0, places=5)
            self.assertIn(predicted, GROWTH4_CLASS_NAMES)


def _frame(classes: list[int]) -> pd.DataFrame:
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return pd.DataFrame(
        {
            "first_seen_at": [(start + timedelta(hours=i)).isoformat() for i in range(len(classes))],
            "growth_class": classes,
        }
    )


class Growth4DefectTest(unittest.TestCase):
    def test_time_split_is_not_label_aware(self) -> None:
        # Moonbag (3) only in the early rows: a label-aware split would walk the
        # cut back to put a 3 in test. A pure time split must not.
        classes = [3, 3] + [0, 1, 2] * 18
        train, test = time_split(_frame(classes), 0.2)
        self.assertEqual(len(train) + len(test), len(classes))
        self.assertEqual(len(test), len(classes) - int(len(classes) * 0.8))
        self.assertNotIn(3, set(test["growth_class"]))
        self.assertLessEqual(
            pd.to_datetime(train["first_seen_at"], utc=True).max(),
            pd.to_datetime(test["first_seen_at"], utc=True).min(),
        )

    def test_time_split_requires_first_seen_at(self) -> None:
        with self.assertRaises(SystemExit):
            time_split(pd.DataFrame({"growth_class": [0, 1, 2, 3]}), 0.25)

    def test_carve_valid_fails_loudly_when_train_too_small(self) -> None:
        with self.assertRaises(SystemExit):
            carve_valid(_frame([0, 1, 2, 3] * 4))  # 16 rows
        train, valid = carve_valid(_frame([0, 1, 2, 3] * 5))  # 20 rows
        self.assertGreater(len(valid), 0)
        self.assertEqual(len(train) + len(valid), 20)
        self.assertEqual(set(train.index) & set(valid.index), set())

    def test_valid_weights_use_train_class_weights(self) -> None:
        y = pd.Series([0] * 6 + [1] * 2 + [2] + [3])
        weights = _class_weight_map(y)
        self.assertAlmostEqual(weights[0], 10 / (4 * 6))
        self.assertAlmostEqual(weights[3], 10 / (4 * 1))
        captured: dict[str, object] = {}
        real_dataset = __import__("lightgbm").Dataset

        def spy(*args, **kwargs):
            captured.setdefault("weights", []).append(kwargs.get("weight"))
            return real_dataset(*args, **kwargs)

        frame, _ = build_growth4_frame(synthetic_raw(), with_ohlc=False)
        cols = list(ENTRY_FEATURE_COLUMNS)
        with mock.patch("train_growth4.lgb.Dataset", side_effect=spy):
            train_growth4(frame, cols, 0.2, 40, num_boost_round=5)
        train_w, valid_w = captured["weights"]
        self.assertIsNotNone(train_w)
        self.assertIsNotNone(valid_w)

    def test_predict_sets_missing_flags_for_absent_entry_features(self) -> None:
        cols = list(ENTRY_FEATURE_COLUMNS)
        vec = dict(zip(cols, vector_from_row({"log_first_mcap": 11.0}, cols)[0], strict=True))
        self.assertEqual(vec["log_first_mcap"], 11.0)
        for col in ("organic_score", "top_holders_pct", "log_volume_5m"):
            self.assertEqual(vec[col], 0.0)
        for flag in ("organic_score_missing", "top_holders_pct_missing", "volume_5m_missing"):
            self.assertEqual(vec[flag], 1.0)
        # NaN counts as missing; present values clear the flag.
        full = {
            "log_first_mcap": 11.0,
            "organic_score": 50,
            "top_holders_pct": float("nan"),
            "log_volume_5m": 6.0,
        }
        vec = dict(zip(cols, vector_from_row(full, cols)[0], strict=True))
        self.assertEqual(vec["organic_score_missing"], 0.0)
        self.assertEqual(vec["top_holders_pct_missing"], 1.0)
        self.assertEqual(vec["volume_5m_missing"], 0.0)
        self.assertEqual(vec["log_volume_5m"], 6.0)

    def test_psql_copy_keeps_url_and_password_out_of_argv(self) -> None:
        url = "postgres://appuser:s3cr%40t@db.example:5433/reload?sslmode=require"
        env = pg_env_from_url(url, base={})
        self.assertEqual(env["PGPASSWORD"], "s3cr@t")
        self.assertEqual(env["PGUSER"], "appuser")
        self.assertEqual(env["PGHOST"], "db.example")
        self.assertEqual(env["PGPORT"], "5433")
        self.assertEqual(env["PGDATABASE"], "reload")
        self.assertEqual(env["PGSSLMODE"], "require")
        with self.assertRaises(SystemExit):
            pg_env_from_url(url + "&options=-c%20x", base={})

        calls: list[tuple[list[str], dict[str, str]]] = []

        def fake_run(argv, **kwargs):
            calls.append((list(argv), kwargs["env"]))
            return mock.Mock(returncode=0, stdout="a,b\n", stderr="")

        with mock.patch.object(export_growth4_data.shutil, "which", return_value="/usr/bin/psql"), \
                mock.patch.object(export_growth4_data.subprocess, "run", side_effect=fake_run):
            psql_copy(url, "COPY (SELECT 1) TO STDOUT")
        argv, run_env = calls[0]
        joined = " ".join(argv)
        self.assertNotIn("s3cr", joined)
        self.assertNotIn("postgres://", joined)
        self.assertEqual(run_env["PGPASSWORD"], "s3cr@t")


if __name__ == "__main__":
    unittest.main()
