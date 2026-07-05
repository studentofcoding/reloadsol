# Operator state (feedback loop)

Living notes for regime awareness and rule changes. Production DB: Docker Postgres **`reloadsol_db`** only (Supabase cut off). Schema: [`db/init/`](../db/init/).

Update after significant sim batches or when disabling a strategy.

## Pattern ML (primary focus — 24h mcap + social cohorts)

Separate from sim-outcome gate — labels come from `mcap_social_pattern_24h` (winner ≥120% growth, loser &lt;80%).

- Pattern DB refreshes automatically via social rollup cron (~every 5 min).
- Check counts: `/dev/social` → **24h Patterns** or `GET /api/mcap-patterns/stats`.
- Target **30+ winners and 30+ losers** before training (`train_ready`).
- Export: `API_BASE_URL=http://127.0.0.1 npm run ml:export-patterns` → `ml/data/pattern/training.parquet`
- Train: `npm run ml:train-pattern` → `ml/artifacts/pattern-gate/`
- Check: `npm run ml:check-pattern`
- Deploy ONNX to web (`ML_PATTERN_ARTIFACT_DIR=/app/ml/artifacts/pattern-gate`); default **`ML_PATTERN_MODE=shadow`**.
- Shadow fields on sim buys: `ml_pattern_p_winner`, `ml_pattern_predicted` — review in Strategy Admin → **Pattern ML** and **24h cohort** columns.
- Do **not** set `ML_PATTERN_MODE=enforce` until `model.meta.json` → `metrics.pattern_ready === true` (macro-F1 ≥ 0.60 on holdout).
- Weekly: export → train → `docker:deploy:web` → compare shadow predictions vs 24h cohort labels.

### Current model baseline (Jul 2026)

From `ml/artifacts/pattern-gate/model.meta.json` (330 train / 66 test):

| Metric | Value | Notes |
|--------|-------|-------|
| `macro_f1` | **0.468** | Below 0.60 → `pattern_ready: false` |
| `accuracy` | 0.879 | Misleading — predicts almost all as class 0 |
| Class 1 (winner) test | P/R/F1 = **0 / 0 / 0** (n=8) | Never predicts winners on holdout |
| Train class counts | `{0: 280, 1: 50}` | ~15% winners — severe imbalance |
| Top features | `log_first_mcap`, `log_mention_count_30m`, `minutes_to_first_mention` | Social/wallet features currently **0** importance |

**Next:** collect more winner cohort rows + address class imbalance before enforce. Shadow-only until class-1 recall improves.

## North star

**Strict checker over brilliant maker.** Primary thesis: `mcap_enter_at_80` sim (milestone entry). Pattern ML compounds that with 24h cohort labels.

## Current focus

| Strategy | Status | Notes |
|----------|--------|-------|
| `mcap_enter_at_80` | **Primary — FROZEN** | Rules locked for data collection; target **200+ sim closes** before ML enforce or live |
| `att` | Active | Registry floor **200k mcap** — sub-50k entries should not assign here; bad under50k WR is usually `lowcap_moonbag` or legacy rows |
| `lowcap_moonbag` | Active | 35k–90k band; deactivate if WR stays &lt;10% over 30+ trades |
| `signals_sell_over_100` | Sim only | Exits on mcap ≥100%; sim PnL now uses mcap basis (fixed price/rug mismatch) |

## Constraints (learned)

- Do not gate live trades on Pattern ML until `pattern_ready === true` (macro-F1 ≥ 0.60).
- Do not gate live on sim-outcome gate until `gate_ready === true` (macro-F1 ≥ 0.65) — secondary track.
- ML checker (Layer 2) must see **entry features only** — never strategy weights or scores (`docs/ML_GATE_PLAN.md`).
- Target checker rejection **40–60%** of candidates in shadow mode; &gt;90% approval means gates are too loose.
- LLM gate (Layer 3): ambiguous cases only; economics favor ONNX-only below ~$100k–250k deployed.

## Regime

Daily tags: Strategy Admin → Reports → **Market regime** (`market_regime_tags` table).

## Data hygiene (sim-outcome gate — secondary)

- Run `npm run ml:backfill-labels` after tier label changes.
- Export versioned data: `API_BASE_URL=http://127.0.0.1 TRENDING_TRACKER_SECRET=... npm run ml:export` → `ml/data/v2/training.parquet` + `dataset_manifest.json`.
- Train gate: `npm run ml:train-gate` → `ml/artifacts/v2-gate/`
- Train potential (advisory): `npm run ml:train-potential` → `ml/artifacts/v2-potential/`
- Check: `npm run ml:check-dataset` / `npm run ml:check-potential`
- Shadow scoring runs on mcap sim opens (`entry_features.ml_gate_*`); **enforce wired but default `ML_GATE_MODE=shadow`**
- Social TTL cleanup every 30m (Go cron → `/api/social/cleanup`); `/dev/social` is manual refresh only
- Weekly loop: `npm run ml:export` → `ml:train-gate` → `ml:check-dataset`; review shadow `ml_gate_p_bad` histogram before setting `ML_GATE_MODE=enforce`
- Do not gate live on v1 multiclass (overfit); use v2-gate `gate_ready` only

## Risk / kill switch

- Real trending bot: global circuit breaker in `bot_trading_state` (auto halt on failures).
- DLMM pause is separate (Telegram `/pause`) — not unified yet.
- Sim workers are **not** halted by real-trading circuit breaker.

## Changelog

| Date | Change |
|------|--------|
| 2026-07-05 | Pattern ML pipeline: 24h cohort export/train, shadow scorer on mcap sim-track, UI feedback columns; Supabase cut off, reloadsol_db only |
| 2026-06-28 | Social TTL cleanup + manual `/dev/social` refresh; `social_overlap` on entry features; L2 enforce wired (default shadow) |
| 2026-06-28 | Two-stage ML: v2-gate binary + v2-potential tiers; shadow ONNX on mcap sim-track |
| 2026-06-28 | Fixed signals sim PnL (mcap vs price); symbol backfill from `token_mcap_tracking`; versioned ML export + gate_ready in train meta |
