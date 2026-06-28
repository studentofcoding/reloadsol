# ML training pipeline (Layer 2)

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

## Phase 0 — Check dataset (app running)

```bash
curl -s 'http://localhost:3000/api/strategies/ml/dataset-stats?domain=mcap_tracker' | jq
```

Response includes `by_gate_class` and `potential_tier_counts`. Target: ≥ 200 labeled rows for gate training.

## Phase 1 — Export & train (v2 two-stage)

```bash
export API_BASE_URL=http://localhost:3000

# → ml/data/v2/training.parquet + dataset_manifest.json (gate_class, potential_tier columns)
npm run ml:export

npm run ml:check-dataset
npm run ml:train-gate
npm run ml:train-potential   # needs ≥30 gate=1 rows, ≥2 tiers
npm run ml:check-potential
```

Manual equivalents:

```bash
cd ml
python train.py --stage gate --input data/v2/training.parquet --version v2-gate
python train.py --stage potential --input data/v2/training.parquet --version v2-potential
python train.py --stage multiclass --input data/v2/training.parquet --version v1  # legacy
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

See [`docs/OPERATOR_STATE.md`](../docs/OPERATOR_STATE.md).

## Feature spec

Mirrors `src/strategies/ml-training-features.ts`:

- `log_entry_mcap`, `organic_score`, `top_holders_pct`, `token_age_hours`, `log_volume_at_entry`
- `entry_template_milestone_80` (0/1)
- One-hot `band_*` for entry mcap band

## Retrain

Re-export after new sim closes. Do not change entry/exit rules mid-collection. Compare both `v2-gate` and `v2-potential` meta before enforce mode.
