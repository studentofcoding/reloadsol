# ML training pipeline (Layer 2)

Train a LightGBM **multiclass** classifier (classes 0–4) on closed `strategy_outcomes`.

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

**NumPy 2.x:** LightGBM/matplotlib in many envs still require NumPy 1.x. This repo pins `numpy<2` in `requirements.txt`. Use a fresh venv or conda env on 3.10–3.12:

```bash
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python -c "import numpy; import lightgbm; print(numpy.__version__, 'ok')"
```

If you already installed NumPy 2 in an existing env:

```bash
pip install 'numpy>=1.26.0,<2.0.0' --force-reinstall
pip install -r requirements.txt
```

## Docker deploy

ML runs on the **host** (or a separate CI job), not in web/cron containers. Changes under `ml/` do **not** trigger Docker rebuild (`docker-scope.sh` skips them). Use `npm run docker:deploy:web` when `src/` or app deps change.

## Phase 0 — Check dataset (app running)

With the Next app up (`npm run dev`):

```bash
curl -s 'http://localhost:3000/api/strategies/ml/dataset-stats?domain=mcap_tracker' | jq
```

Target: `stats.ready === true` (≥ 200 labeled rows), `stats.train_ready === true` (balanced tiers).

Backfill stored labels on existing rows (optional — export recomputes anyway):

```bash
# Local script (loads .env / .env.local)
npm run ml:backfill-labels -- --dry-run
npm run ml:backfill-labels
npm run ml:backfill-labels -- --domain=trending_bot --strategy-id=att

# Or via API (app running; key required in production)
curl -X POST 'http://localhost:3000/api/strategies/ml/backfill-labels?dry_run=true&domain=mcap_tracker&key=YOUR_SECRET'
curl -X POST 'http://localhost:3000/api/strategies/ml/backfill-labels?domain=mcap_tracker&key=YOUR_SECRET'
```

In **Strategy Admin → Reports**, use **Backfill auto labels** on the Outcomes table (preview → confirm). Respects current domain/strategy filters.

## Phase 1 — Export & train

```bash
export API_BASE_URL=http://localhost:3000

# All domains, recomputed tier labels
python export_training_data.py --output data/training.parquet

# Single domain
python export_training_data.py --domain mcap_tracker --output data/training.parquet

python check_dataset.py data/training.parquet --min-rows 30
python train.py --input data/training.parquet --version v1 --min-rows 33
```

### ML v2 (social + telegram features)

After sim outcomes include social fields from entry snapshots:

```bash
python export_training_data.py --version v2 --output data/training_v2.parquet
python train.py --input data/training_v2.parquet --version v2 --min-rows 200
```

Artifacts land in `ml/artifacts/v2/` with five extra features: mention counts, unique channels, minutes since first mention, smart-wallet buy count, and `has_smart_wallet_buy`.

## v1 artifacts

| File | Purpose |
|------|---------|
| `model.onnx` | Node inference (Phase 2) |
| `model.lgb.txt` | Native LightGBM fallback |
| `model.meta.json` | Feature order, macro-F1, class counts |

## Tier labels (`training_class`)

| Class | Condition |
|-------|-----------|
| **0** | Lost, negative PnL, or won with PnL < 20% |
| **1** | Won, 20% ≤ PnL < 50% |
| **2** | 50% ≤ PnL < 100% |
| **3** | 100% ≤ PnL < 300% |
| **4** | PnL ≥ 300% |

## Feature spec

Mirrors `src/strategies/ml-training-features.ts`:

- `log_entry_mcap`, `organic_score`, `top_holders_pct`, `token_age_hours`, `log_volume_at_entry`
- `entry_template_milestone_80` (0/1)
- One-hot `band_*` for entry mcap band

## Retrain

Re-export after new sim outcomes close, bump version (`--version v2`), compare `model.meta.json` metrics before deploying.
