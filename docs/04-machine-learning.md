# ReloadSOL — Machine Learning (condensed)

> **Diagram:** [ML pipeline](./diagrams/05-ml-pipeline.html).

Condensed from `docs/deep_dive_ml.md`, `docs/ML_GATE_PLAN.md`, `docs/ARCHITECTURE_SUMMARY.md` (§4 ML), `docs/mcap-tracker.md` (Pattern ML + sim-track), and `ml/README.md` (**present** at `ml/README.md`). Verify details in those files before acting.

## 1. Purpose and consumers

ReloadSOL ML is **supervised tabular classification with LightGBM**: models gate/rank token *entries* and are consumed by the strategy/sim runtime, not by a human analyst.

- **Pattern-gate model (PRIMARY track)** — binary classifier over 24h mcap + social cohort labels; scores sim buys as a buy/entry filter (`pattern_class` winner=1 / loser=0). See `docs/ARCHITECTURE_SUMMARY.md` §4 Track B, `docs/mcap-tracker.md` "Pattern ML + sim-track".
- **v2-gate (secondary, sim-outcome "Layer 2")** — binary `gate_class` 0=skip / 1=allow (win ≥20%) entry filter; and **v2-potential** — 4-tier upside bucket on winners, advisory exit-overlay. See `docs/ML_GATE_PLAN.md` Phase 1/2.
- **Who consumes it:** strategies/TS workers. Runtime hook `attachMlEntryShadow()` in `src/strategies/ml-entry-shadow.ts` is called on sim-track opens (mcap, signals, trending, **gmgn**) and shadows scores onto `entry_features` (`ml_gate_*`, `ml_potential_*`, `ml_pattern_*`). Stage-1 Signals early alerts display Pattern ML `p_winner` for copy-trade display only (`src/strategies/signals-early-alerts.ts`). **Soft size** (`src/strategies/ml-soft-size.ts`) scales mcap/signals/gmgn size by `(1 − pBad) × confidence` with floor `SOL_ML_SIZE_FLOOR` (default 0.25); it does not skip. Trending/social skip that size path.
- **Runtime inference:** ONNX scored in Node via `onnxruntime-node` inside the Next.js web container. `ml/artifacts/` is bind-mounted `./ml/artifacts:/app/ml/artifacts:ro` (`docker-compose.yml` web service), and env keys point at each model dir (`ML_PATTERN_ARTIFACT_DIR`, `ML_GATE_ARTIFACT_DIR`, `ML_POTENTIAL_ARTIFACT_DIR`). Training runs on the **host**, never in web/cron containers.
- **Modes:** all models default **shadow** (score + stamp, never block). Enforce/apply only when the meta's `*_ready` bar is true and mode is flipped — see §6.
- Checker/maker rule: models see **entry-time features only** — never exit mcap/PnL, monitor snapshots, or strategy weights (`docs/ML_GATE_PLAN.md` "Entry-time features (no leakage)").

## 2. Repo layout — `ml/` top level

`ml/README.md` **is present** (ops commands, naming table, baselines). Top-level contents:

| Path | Purpose |
|------|---------|
| `ml/export_training_data.py` | Pull labeled `strategy_outcomes` → parquet (`--features v1` entry-12 cols; `--features v2` adds social; `--domain mcap_tracker`) |
| `ml/export_pattern_data.py` | Pull 24h cohort labels from `GET /api/mcap-patterns/training-export` → `ml/data/pattern/training.parquet` (`--chain`, default `sol`) |
| `ml/train.py` | LightGBM + ONNX for gate / potential (`--stage gate|potential`) |
| `ml/train_pattern.py` | LightGBM + ONNX for pattern-gate (3-way split, threshold tuning) |
| `ml/features.py` | Entry feature vector + tier/gate/potential label helpers (mirrors `src/strategies/ml-training-features.ts`) |
| `ml/pattern_features.py` | Pattern feature vector + coverage report (mirrors `src/strategies/social/pattern-features.ts`) |
| `ml/check_dataset.py` / `ml/check_pattern_dataset.py` | Local parquet readiness checks (row counts vs bars, meta compare) |
| `ml/train_pattern_test.py`, `ml/mcap_strategy_search_optuna.py`, `ml/requirements.txt` | Test / strategy search utility / deps |
| `ml/data/` | `v2/training.parquet`, `v2/dataset_manifest.json`, `v2/training_experimental.parquet`, `pattern/training.parquet`, `pattern/dataset_manifest.json`, legacy `training.parquet` |
| `ml/artifacts/` | On disk today: `pattern-gate/` only (`model.lgb.txt`, `model.onnx`, `model.meta.json`); `v2-gate` / `v2-potential` are written here by the train npm scripts when run |

Feature schemas:

- **Entry (12 cols)** = `log_entry_mcap`, `organic_score`, `top_holders_pct`, `token_age_hours` (cap 168h), `log_volume_at_entry`, `entry_template_milestone_80`, one-hot `band_*` (6 mcap bands) — `ml/features.py`.
- **Pattern (10 cols)** = `log_first_mcap`, mentions/channels 30m, `minutes_to_first_mention`, smart-wallet flags, GMGN FOMO source, plus GMGN activity fields (`gmgn_activity_score_60m`, `log_gmgn_sm_wallets_60m`, `has_gmgn_hot_before_entry`) — `ml/pattern_features.py`. Docs warn: **retrain required after GMGN columns were added** (`docs/deep_dive_ml.md` §4; on-disk `pattern-gate/model.meta.json` still lists the older 7-column vector).

## 3. Pipeline stages

1. **Export training data.** npm scripts (`package.json`) wrap the Python: `ml:export-entry-features` (alias `ml:export`) → `ml/data/v2/training.parquet` via `export_training_data.py --features v1 --domain mcap_tracker`; `ml:export-patterns` → `ml/data/pattern/training.parquet` via `export_pattern_data.py`. Both need `API_BASE_URL` (prod: `http://127.0.0.1` nginx :80) and `TRENDING_TRACKER_SECRET` (auth `?key=`). Checkers: `ml:check-dataset`, `ml:check-potential`, `ml:check-pattern`. Readiness API `GET /api/strategies/ml/dataset-stats?domain=mcap_tracker` returns `labeled`, `extractable_labeled` (rows with the full 12-col vector — this is the 200-row target), `by_gate_class`, `potential_tier_counts` (`ml/README.md` Phase 0; `docs/OPERATOR_STATE.md` "Data hygiene").
2. **Train.** Two tracks:
   - Gate/potential: `python3 train.py --stage gate|potential --input data/v2/training.parquet --version v2-gate|v2-potential` (npm `ml:train-gate` / `ml:train-potential`). `train.py` does a **time-ordered split** (`time_split`, by entry order) then `carve_valid()` peels a validation tail so early stopping **never watches the test holdout** (leak fixed 2026-07).
   - Pattern: `python3 train_pattern.py --input data/pattern/training.parquet --version pattern-gate`. `three_way_split()` makes a **time-ordered train/valid/test 3-way split**; test is carved first with a class-minimum backstop (`MIN_TEST_WINNERS`/`MIN_TEST_LOSERS`), then valid; the **decision threshold is tuned on valid only** (`tune_decision_threshold` over 0.05–0.95, `threshold_tuned_on: "valid"`); test is untouched until final metrics.
   - Readiness bars (`ml/features.py`, `ml/pattern_features.py`, `ml/README.md`): gate **200** labeled rows, macro-F1 ≥ **0.65**, test ≥ 20 → `gate_ready`; potential **30** gate=1 rows, macro-F1 ≥ **0.55**, test ≥ 10 → `potential_ready`; pattern **60** rows / ≥30 per class, macro-F1 ≥ **0.60**, test ≥ 10 → `pattern_ready`. Minimums are enforced in `train.py` (`MIN_LABELED_OUTCOMES=200`, `get_min_potential_outcomes()`); pattern trains with `scale_pos_weight` and early stopping on `auc`.
3. **Evaluate.** Meta metrics written into `model.meta.json`:
   - Gate/potential: `macro_f1`, `pr_auc` (average precision), `winner_recall`/`winner_precision`/`winner_f1` (class-1 for gate), accuracy, `feature_importance` (gain), readiness flags (`ml/train.py`).
   - Pattern: same + `valid_macro_f1`, `decision_threshold`, `classification_report`, class counts, and a per-feature **coverage report** (`feature_coverage` with `non_null_rate` / `non_zero_rate`; all-zero **social** columns flagged) — `ml/pattern_features.py feature_coverage_report()`. Export also logs coverage (`featureCoverage` in the training-export response) so "missing at export" ≠ "present but uninformative".
   - Honest-metrics caveat baked into docs: pattern baseline predicts almost all losers — high accuracy (0.879) with **winner-class recall 0** on holdout; accuracy is not the gate metric.
4. **Ship artifacts.** Trainers write `ml/artifacts/<version>/model.lgb.txt` (LightGBM text), `model.onnx` (via `export_onnx`), `model.meta.json` (feature order, train/valid/test rows, metrics, `feature_importance`). The pattern daily job additionally writes `ml/artifacts/pattern-gate/pipeline_state.json` (status/metrics/log tail) and reloads ONNX via `POST /api/ml/pattern/reload` **without a full web restart** (`ml/README.md` "Daily automation").
5. **Runtime inference.** Web container loads artifacts lazily and caches ONNX sessions per process:
   - `src/strategies/entry-ml-scorer.server.ts` — dual gate + potential ONNX (`loadStageModel` reads `model.meta.json` + `model.onnx`; `ML_GATE_ARTIFACT_DIR` / `ML_POTENTIAL_ARTIFACT_DIR`, defaults `artifacts/v2-gate` / `v2-potential`).
   - `src/strategies/entry-pattern-scorer.server.ts` — pattern ONNX (`ML_PATTERN_ARTIFACT_DIR`; session cache in `entry-pattern-scorer-cache.ts`; load status via `/api/ml/pattern/reload`).
   - Feature vector order must equal `meta.feature_columns` (tensor input built from meta). Deploy verification: `scripts/docker-deploy.sh` `verify_standalone_build()` fails the build if `.next/standalone/node_modules/onnxruntime-node/bin` lacks `libonnxruntime.so*` or `onnxruntime_binding.node`; `next.config.js` uses `output: 'standalone'` with `outputFileTracingIncludes` for `onnxruntime-node/bin` on the sim-track and pattern-reload routes. Gate/potential ONNX are **not** hot-reloaded — restart `reloadsol-web` after a potential/gate retrain (`docs/OPERATOR_STATE.md` server checklist).

## 4. Labels and coverage logging

- **Sim-outcome labels (Track A).** On close, strategy sims record `strategy_outcomes` (e.g. `recordMcapTrackerOutcome` in `src/strategies/outcomes.ts`, closed via `close-strategy-sim-position.ts`). Labels are **recomputed from `pnl_pct` + status**, not stored by hand: `computeTrainingClass()` in `src/strategies/outcome-labeling.ts` → `training_class` tiers 0–4 (0 = loss or win <20%; 1 = 20–50%; 2 = 50–100%; 3 = 100–300%; 4 = ≥300%); `gate_class` = 0 iff class 0 else 1; `potential_tier` = class 1–4 on gate=1 only. Python mirrors: `ml/features.py` (`compute_training_class`, `gate_class_from_training_class`, `potential_tier_from_training_class`). `ml:backfill-labels` / `POST /api/strategies/ml/backfill-labels` refresh stored labels after tier-rule changes. Tracked-position history: `token_mcap_tracking` milestones + `mcap_social_pattern_24h` cohort tables feed pattern labels; `mcap-tracker.md` documents sim workers `mcap_tracker_sim_open` (phase=open ~15s) and `mcap_tracker_sim_track` (phase=manage ~120s) that open/manage sims and stamp `ml_pattern_*` shadow on entry.
- **Pattern labels (Track B, primary).** Social rollup cron (~5m) writes `mcap_social_pattern_24h` for tokens first seen in the last 24h: **winner ≥120% growth, loser <80%** (neutral not stored). `pattern_class_from_cohort()` in `ml/pattern_features.py`; export reads `GET /api/mcap-patterns/training-export` (auth `TRENDING_TRACKER_SECRET`).
- **Coverage / dataset-health logging:** export counts `incomplete`, `volume_imputed` (missing `volume_at_entry` → `log_volume_at_entry=0`, imputed not dropped), `incomplete_by_field`, `skipped_incomplete`; manifests in `ml/data/*/dataset_manifest.json`; `model.meta.json` records `train_rows`/`valid_rows`/`test_rows` and (pattern) `feature_coverage`. Tracking "menuju 200": use `stats.extractable_labeled` from the dataset-stats endpoint, not `ml:backfill-labels` preview or `ml:export` row count — the three count different things (`docs/OPERATOR_STATE.md` "Data hygiene").

## 5. Baselines / current state (per docs, Jul 2026)

- Pattern-gate: `macro_f1` **0.468**, accuracy 0.879, test winner P/R/F1 = **0/0/0** (n≈8), train class counts `{0: 280, 1: 50}` (~15% winners) → `pattern_ready: false`, **shadow only**. Class imbalance is the stated blocker (`ml/README.md`, `docs/OPERATOR_STATE.md`, `docs/ARCHITECTURE_SUMMARY.md` §4). On-disk `ml/artifacts/pattern-gate/model.meta.json` (2026-07-05 train): 228 train / 57 test, class counts `{0:251,1:34}`, winner support 7.
- Sim-outcome gate/potential: ~95 export rows (0 incomplete, 45 volume-imputed); potential train 53 / test 14, **macro-F1 0.33** → `potential_ready: false`; gate blocked until **200** labeled (`ml/README.md` "Latest potential baseline", `docs/deep_dive_ml.md` snapshot).
- Daily pattern automation: host cron **03:00 UTC** via `scripts/install-ml-pattern-cron.sh` → `scripts/ml-pattern-daily.sh` (export → check → train if `train_ready` → reload ONNX; status `partial` if <30 winners/losers per class; logs `logs/ml-pattern-daily.log`).

## 6. When models act (not just shadow)

- **Gate/pattern enforce:** wired but off by default (`ML_GATE_MODE=shadow`, `ML_PATTERN_MODE=shadow`). Enforce requires meta `*_ready === true` plus review; gate rejects when `ml_gate_p_bad > ML_GATE_P_BAD_MAX` (default 0.5, reason `ml_gate_reject`); pattern rejects when `p_winner < ML_PATTERN_P_WINNER_MIN` (reason `ml_pattern_reject`) — `entry-ml-scorer.server.ts evaluateMlGateEnforce`, `entry-pattern-scorer.server.ts evaluatePatternEnforce`.
- **Potential exit overlay:** `ML_POTENTIAL_EXIT_MODE=shadow|apply|off`; `apply` (sim only) adjusts sim TP/SL through `potential-exit-overlay.ts` when `potential_ready`. Live capital is never gated by these models.
- **Soft size is always on** for mcap/signals/gmgn (paper and live mcap). It is not enforce. Do **not** flip `ML_GATE_MODE` / `ML_PATTERN_MODE` to enforce while Pattern F1 is ~0.47.
- Do-not list (`docs/OPERATOR_STATE.md` constraints, `docs/ML_GATE_PLAN.md` risks): don't gate live until `*_ready`; don't change frozen entry/exit rules mid-collection; reject live gating when `metrics.gate_ready` is false; review shadow `ml_gate_p_bad` histograms before flipping enforce. Current-state: [DECISION_MACHINE.md](./DECISION_MACHINE.md).
