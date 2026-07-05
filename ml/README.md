# ML training pipeline

**Primary focus: Pattern ML** (24h mcap + social cohort labels). **Secondary:** sim-outcome gate (Layer 2) below.

Production DB: Docker Postgres **`reloadsol_db`** only. Train on **host**, not in web/cron containers.

---

## Pattern ML (primary)

Labels from `mcap_social_pattern_24h` (winner ≥120% growth, loser &lt;80%). Shadow scores mcap sim entries (`ml_pattern_p_winner`, `ml_pattern_predicted`).

Full ops: [docs/OPERATOR_STATE.md](../docs/OPERATOR_STATE.md), [docs/ARCHITECTURE_SUMMARY.md](../docs/ARCHITECTURE_SUMMARY.md).

### Setup

Same venv as below (`cd ml && python3 -m venv venv && pip install -r requirements.txt`). Also install `packaging` if ONNX export fails.

### Export & train (host — prod uses nginx :80)

```bash
export API_BASE_URL=http://127.0.0.1
export TRENDING_TRACKER_SECRET=...

npm run ml:export-patterns   # → ml/data/pattern/training.parquet
npm run ml:check-pattern
npm run ml:train-pattern     # → ml/artifacts/pattern-gate/
npm run docker:deploy:web    # volume mount picks up ONNX
```

Docker env: `ML_PATTERN_MODE=shadow`, `ML_PATTERN_ARTIFACT_DIR=/app/ml/artifacts/pattern-gate`.

### Artifacts

| Path | Purpose |
|------|---------|
| `artifacts/pattern-gate/model.onnx` | Pattern gate — shadow + future enforce |
| `artifacts/pattern-gate/model.meta.json` | `metrics.pattern_ready`, class counts, feature importance |

Enforce when `pattern_ready === true` (macro-F1 ≥ **0.60**).

### Current baseline (Jul 2026)

| Metric | Value |
|--------|-------|
| `macro_f1` | **0.468** → `pattern_ready: false` |
| Class 1 test recall | **0** (n=8) |
| Train class counts | `{0: 280, 1: 50}` |
| Top features | `log_first_mcap`, `log_mention_count_30m`, `minutes_to_first_mention` |

Stay **shadow-only** until class-1 recall improves. Collect more winner cohort rows before enforce.

Features mirror [`src/strategies/social/pattern-features.ts`](../src/strategies/social/pattern-features.ts).

---

## Sim-outcome gate (Layer 2 — secondary)

Two-stage entry models on closed `strategy_outcomes`:

- **Stage A (gate):** binary `gate_class` — skip (0) vs allow (1)
- **Stage B (potential):** tiers 1–4 on winners only (advisory)

Full plan: [docs/ML_GATE_PLAN.md](../docs/ML_GATE_PLAN.md)

## Setup

```bash
cd ml
python3 -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

**macOS:** if LightGBM fails with `libomp.dylib` not loaded:

```bash
brew install libomp
```

Use **Python 3.10–3.12** (not 3.14 — SciPy/LightGBM stacks conflict with `numpy<2` on 3.14).

## Docker deploy

ML runs on the **host** (or a separate CI job), not in web/cron containers. Node shadow scoring uses `onnxruntime-node` in the **web** container — redeploy web after scorer changes.

## Naming (avoid confusion)

| Term | Meaning |
|------|---------|
| **`--features v1/v2`** (Python export) | Feature columns in parquet (v2 adds social) |
| **`ml:export-v1-features`** | npm script → features v1 → `data/v2/training.parquet` |
| **`ml:export-v2-social-experimental`** | npm script → features v2 → `training_experimental.parquet` |
| **`ml:export`** | Alias for `ml:export-v1-features` |
| **`data/v2/`** | Dataset path for the **v2 gate pipeline** (not “feature v2”) |
| **`v2-gate` / `v2-potential`** | Model artifact folders (train.py `--version`) |
| **`pattern-gate`** | Separate Pattern ML track |

## Phase 0 — Check dataset (app running)

```bash
export API_BASE_URL=http://127.0.0.1   # prod VPS: nginx :80, not :3000
export TRENDING_TRACKER_SECRET=...

curl -s "${API_BASE_URL}/api/strategies/ml/dataset-stats?domain=mcap_tracker&key=${TRENDING_TRACKER_SECRET}" | jq
```

Response includes `by_gate_class` and `potential_tier_counts`. Target: ≥ 200 labeled rows for gate training.

## Phase 1 — Export & train (v2 two-stage)

```bash
export API_BASE_URL=http://127.0.0.1
export TRENDING_TRACKER_SECRET=...

# → ml/data/v2/training.parquet (features v1; gate train uses v1 columns)
npm run ml:backfill-labels   # optional: refresh training_class on outcomes first
npm run ml:export              # alias → ml:export-v1-features
npm run ml:check-dataset
npm run ml:train-gate
npm run ml:train-potential   # needs ≥30 gate=1 rows, ≥2 tiers
npm run ml:check-potential
```

Optional export **with social feature columns** (not used by v2-gate scorer yet):

```bash
npm run ml:export-v2-social-experimental   # → data/v2/training_experimental.parquet
```

Manual equivalents:

```bash
cd ml
python3 export_training_data.py --features v1 --domain mcap_tracker
python3 train.py --stage gate --input data/v2/training.parquet --version v2-gate
python3 train.py --stage potential --input data/v2/training.parquet --version v2-potential
python3 train.py --stage multiclass --input data/v2/training.parquet --version v1  # legacy
```

## Labels

| Column | Meaning |
|--------|---------|
| `training_class` | Legacy tiers 0–4 (UI / backfill) |
| `gate_class` | **0** = class 0; **1** = classes 1–4 |
| `potential_tier` | **1–4** when gate=1; null otherwise |

Tier rules (`training_class` / derived columns):

| Class | Condition |
|-------|-----------|
| **0** | Loss, negative PnL, or win &lt; 20% |
| **1** | 20% ≤ PnL &lt; 50% |
| **2** | 50% ≤ PnL &lt; 100% |
| **3** | 100% ≤ PnL &lt; 300% |
| **4** | PnL ≥ 300% |

## Artifacts

| Path | Purpose |
|------|---------|
| `artifacts/v2-gate/model.onnx` | Binary gate — shadow + future enforce |
| `artifacts/v2-potential/model.onnx` | Upside tier — advisory |
| `*/model.meta.json` | `metrics.gate_ready`, feature order |

Gate ready: macro-F1 ≥ **0.65** (200+ rows). Potential ready: macro-F1 ≥ **0.55** (30+ winners).

## Shadow runtime (Node)

After training, sim buys on mcap tracker persist shadow scores on `entry_features`:

- `ml_gate_p_bad`, `ml_gate_predicted`
- `ml_potential_tier`, `ml_potential_moon_score`

Env: `ML_GATE_ARTIFACT_DIR`, `ML_POTENTIAL_ARTIFACT_DIR`, `ML_GATE_MODE=shadow` (default).

In production/Docker, use **absolute** paths (e.g. `/app/ml/artifacts/v2-gate`) to avoid broad standalone file tracing. Relative paths work locally.

Training writes to `ml/artifacts/<version>/` when run from this directory. On the web host, set env to that path (e.g. `ml/artifacts/v2-gate`) or train with `--output-dir ../artifacts/v2-gate` to match the Node default (`artifacts/v2-gate` at repo root).

`npm run build` removes local `venv` / `ml/venv` before Turbopack (broken symlinks panic the bundler). Recreate after build: `cd ml && python3 -m venv venv && pip install -r requirements.txt`.

See [`docs/OPERATOR_STATE.md`](../docs/OPERATOR_STATE.md).

## Feature spec

Mirrors `src/strategies/ml-training-features.ts`:

- `log_entry_mcap`, `organic_score`, `top_holders_pct`, `token_age_hours`, `log_volume_at_entry`
- `entry_template_milestone_80` (0/1)
- One-hot `band_*` for entry mcap band

## Retrain

Re-export after new sim closes. Do not change entry/exit rules mid-collection. Compare both `v2-gate` and `v2-potential` meta before enforce mode.
