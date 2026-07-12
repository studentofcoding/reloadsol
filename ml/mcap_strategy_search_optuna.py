#!/usr/bin/env python3
"""
P1: Optuna search over mcap exit/entry params using the P0 TS scorer.

  cd ml && pip install -r requirements.txt
  python3 mcap_strategy_search_optuna.py --trials=40 --holdout-weeks=4

Requires DATABASE_URL (same as npm run mcap:strategy-search).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def score_config(config: dict, holdout_weeks: int, min_trades: int) -> dict:
    cmd = [
        "npx",
        "tsx",
        str(ROOT / "scripts" / "mcap-strategy-search.ts"),
        f"--score-json={json.dumps(config, separators=(',', ':'))}",
        f"--holdout-weeks={holdout_weeks}",
        f"--min-trades={min_trades}",
    ]
    env = os.environ.copy()
    proc = subprocess.run(
        cmd,
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr or proc.stdout or "score failed")
    # Last JSON line is the machine score
    for line in reversed(proc.stdout.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            return json.loads(line)
    raise RuntimeError(f"no JSON score in output:\n{proc.stdout}")


def walk_forward_gate(config: dict, holdout_weeks: int, min_trades: int) -> bool:
    scored = score_config(config, holdout_weeks, min_trades)
    if int(scored.get("tradeCount") or 0) < min_trades:
        return False
    return bool(scored.get("beatsBaseline"))


def main() -> None:
    try:
        import optuna
    except ImportError:
        print("Install optuna: pip install optuna", file=sys.stderr)
        sys.exit(1)

    parser = argparse.ArgumentParser(description="Optuna mcap strategy search")
    parser.add_argument("--trials", type=int, default=30)
    parser.add_argument("--holdout-weeks", type=int, default=4)
    parser.add_argument("--min-trades", type=int, default=5)
    parser.add_argument("--out", type=str, default=str(ROOT / "tmp" / "mcap-optuna-best.json"))
    args = parser.parse_args()

    def objective(trial: "optuna.Trial") -> float:
        entry_template = trial.suggest_categorical(
            "entryTemplate", ["first_seen", "milestone_80"]
        )
        stop_loss = trial.suggest_float("stopLossPct", -80.0, -20.0)
        take_profit = trial.suggest_float("takeProfitPct", 80.0, 400.0)
        max_hold = trial.suggest_categorical("maxHoldHours", [24, 48, 72, 96, 168])
        mcap_min = trial.suggest_categorical("mcapMin", [20_000, 30_000, 50_000])
        mcap_max = trial.suggest_categorical("mcapMax", [500_000, 1_000_000, 2_000_000])

        config = {
            "id": f"optuna_{trial.number}_{entry_template}",
            "entry": {
                "mcapMin": mcap_min,
                "mcapMax": mcap_max,
                "entryTemplate": entry_template,
            },
            "exit": {
                "stopLossPct": round(stop_loss, 1),
                "takeProfitPct": round(take_profit, 1),
                "maxHoldHours": max_hold,
            },
        }
        scored = score_config(config, args.holdout_weeks, args.min_trades)
        trades = int(scored.get("tradeCount") or 0)
        if trades < args.min_trades:
            raise optuna.TrialPruned()
        loss_streak = int(scored.get("maxLossStreakWeeks") or 0)
        if loss_streak >= 4:
            # Soft constraint: heavily penalize long loss streaks
            return float(scored.get("objective") or 0) - 500.0 * loss_streak
        trial.set_user_attr("config", config)
        trial.set_user_attr("score", scored)
        return float(scored.get("objective") or 0)

    study = optuna.create_study(direction="maximize")
    study.optimize(objective, n_trials=args.trials, catch=(RuntimeError,))

    best = study.best_trial
    config = best.user_attrs.get("config") or {}
    score = best.user_attrs.get("score") or {}
    passes = walk_forward_gate(config, args.holdout_weeks, args.min_trades) if config else False

    payload = {
        "generatedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "source": "optuna",
        "trials": args.trials,
        "bestValue": best.value,
        "passesWalkForwardGate": passes,
        "config": config,
        "score": score,
        "candidates": [
            {
                "id": config.get("id"),
                "config": config,
                "holdout": score,
                "beatsBaseline": passes,
            }
        ],
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2))
    print(json.dumps({"bestValue": best.value, "passesWalkForwardGate": passes, "out": str(out_path)}))
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
