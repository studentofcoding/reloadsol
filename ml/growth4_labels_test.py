#!/usr/bin/env python3
"""Locked 4-class cuts, Pattern shadow, and OHLC window alignment."""

from __future__ import annotations

import json
import math
import unittest

from growth4 import (
    ENTRY_FEATURE_COLUMNS,
    LABEL_COLUMNS,
    GROWTH4_CLASS_NAMES,
    format_shadow_log,
    growth_class_from_percent,
    growth_class_name,
    ohlc_window_features,
    pattern_shadow_class_from_growth,
    probs_from_row,
    resolve_feature_columns,
)


class Growth4LabelTest(unittest.TestCase):
    def test_locked_cuts_including_former_gap(self) -> None:
        cases = [
            (-0.01, "loser"),
            (-100.0, "loser"),
            (0.0, "bep"),
            (10.0, "bep"),
            (20.0, "bep"),
            (20.0001, "winner"),
            (80.0, "winner"),
            (119.999, "winner"),
            (120.0, "moonbag"),
            (500.0, "moonbag"),
        ]
        for growth, name in cases:
            idx = growth_class_from_percent(growth)
            self.assertIsNotNone(idx, growth)
            assert idx is not None
            self.assertEqual(growth_class_name(idx), name, growth)

    def test_missing_growth_is_unlabeled(self) -> None:
        for value in (None, "", "nan", "nope", float("nan")):
            self.assertIsNone(growth_class_from_percent(value))

    def test_pattern_shadow_keeps_binary_cuts(self) -> None:
        self.assertEqual(pattern_shadow_class_from_growth(120), 1)
        self.assertEqual(pattern_shadow_class_from_growth(446), 1)
        self.assertEqual(pattern_shadow_class_from_growth(79.99), 0)
        self.assertEqual(pattern_shadow_class_from_growth(-5), 0)
        self.assertIsNone(pattern_shadow_class_from_growth(80))
        self.assertIsNone(pattern_shadow_class_from_growth(119.9))
        # bep band is a real 4-class and still a Pattern loser (<80).
        self.assertEqual(growth_class_name(growth_class_from_percent(10) or 0), "bep")
        self.assertEqual(pattern_shadow_class_from_growth(10), 0)
        # 90% is winner for 4-class and neutral for Pattern.
        self.assertEqual(growth_class_name(growth_class_from_percent(90) or 0), "winner")
        self.assertIsNone(pattern_shadow_class_from_growth(90))

    def test_ohlc_window_pads_left_and_anchors_on_first_close(self) -> None:
        bars = [
            {"t": 1, "o": 1.0, "h": 1.1, "l": 0.9, "c": 1.0},
            {"t": 2, "o": 1.0, "h": 1.2, "l": 0.8, "c": 1.05},
        ]
        feats = ohlc_window_features(json.dumps(bars))
        self.assertEqual(feats["ohlc_n"], 2.0)
        self.assertEqual(feats["ohlc_ret_0"], 0.0)
        self.assertEqual(feats["ohlc_ret_8"], 0.0)
        self.assertAlmostEqual(feats["ohlc_ret_9"], math.log(1.05), places=6)
        self.assertEqual(ohlc_window_features(None)["ohlc_n"], 0.0)

    def test_label_columns_are_not_entry_features(self) -> None:
        self.assertEqual(set(ENTRY_FEATURE_COLUMNS) & set(LABEL_COLUMNS), set())

    def test_ohlc_features_refused_without_override_and_auto_is_entry(self) -> None:
        from growth4 import all_feature_columns

        cols = all_feature_columns()
        # auto must never pull label-time OHLC, even when bars are present.
        self.assertEqual(resolve_feature_columns("auto", cols, True), list(ENTRY_FEATURE_COLUMNS))
        self.assertEqual(resolve_feature_columns("entry", cols, True), list(ENTRY_FEATURE_COLUMNS))
        for mode in ("ohlc", "all"):
            with self.assertRaises(SystemExit):
                resolve_feature_columns(mode, cols, True)
        chosen = resolve_feature_columns("all", cols, True, allow_label_time_ohlc=True)
        self.assertEqual(chosen, all_feature_columns())

    def test_shadow_log_names_four_probs(self) -> None:
        probs = probs_from_row([0.1, 0.2, 0.3, 0.4])
        self.assertAlmostEqual(sum(probs.values()), 1.0, places=6)
        line = format_shadow_log(probs, "moonbag", "mint")
        for name in GROWTH4_CLASS_NAMES:
            self.assertIn(f"p_{name}=", line)
        self.assertIn("paper_size=off", line)
        self.assertIn("serve=shadow", line)


if __name__ == "__main__":
    unittest.main()
