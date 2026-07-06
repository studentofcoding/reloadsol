#!/usr/bin/env python3
"""Smoke tests for pattern-gate training helpers."""

from __future__ import annotations

import unittest

import numpy as np
from sklearn.metrics import f1_score

from train_pattern import compute_scale_pos_weight, tune_decision_threshold
import pandas as pd


class TrainPatternHelpersTest(unittest.TestCase):
    def test_scale_pos_weight_majority_losers(self) -> None:
        y = pd.Series([0] * 280 + [1] * 50)
        self.assertAlmostEqual(compute_scale_pos_weight(y), 280 / 50, places=5)

    def test_scale_pos_weight_no_winners(self) -> None:
        y = pd.Series([0] * 10)
        self.assertAlmostEqual(compute_scale_pos_weight(y), 10.0, places=5)

    def test_tune_threshold_beats_default_on_imbalanced_probs(self) -> None:
        # Winners score 0.35–0.45; losers mostly below 0.3 — 0.5 threshold misses all winners.
        y_true = np.array([0] * 90 + [1] * 10)
        proba = np.array([0.05] * 85 + [0.25] * 5 + [0.35] * 5 + [0.42] * 5)
        threshold, tuned_f1 = tune_decision_threshold(proba, y_true)
        default_f1 = float(
            f1_score(y_true, (proba >= 0.5).astype(int), average="macro", zero_division=0)
        )
        self.assertGreater(tuned_f1, default_f1)
        self.assertLess(threshold, 0.5)


if __name__ == "__main__":
    unittest.main()
