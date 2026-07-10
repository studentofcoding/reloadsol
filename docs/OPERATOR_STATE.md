# Operator state (feedback loop)

Living notes for regime awareness and rule changes. Production DB: Docker Postgres **`reloadsol_db`** only (Supabase cut off). Schema: [`db/init/`](../db/init/).

Update after significant sim batches or when disabling a strategy.

## Docker rebuilds — what survives

| State | Survives `docker compose up --build` / `down` + `up`? |
|-------|------------------------------------------------------|
| Open/sim positions, SL/TP, DLMM, trackers, outcomes | **Yes** — `postgres_data` volume |
| Cron Workers UI last-success / errors | **Yes** — `cron_worker_runtime` (hydrated into Go on cron start) |
| Redis API cache | **Yes** — `redis_data` volume (TTLs still apply) |
| Cron process uptime / next_run | **No** — recalculated on cron start |

**Do not** run `docker compose down -v` unless you intend to wipe Postgres + Redis volumes.

After first deploy of this change on an existing volume, the web API creates `cron_worker_runtime` on first use (no volume wipe needed). Rebuild **web + cron** so hydrate/persist is live.

## Engine spine (Phase A + B)

Canonical params/features + ML1/ML2/Pattern **shadow** on mcap, signals, and trending opens (`attachMlEntryShadow`). DLMM mint-keyed when resolvable.

**Phase B — Potential → TP/SL:** `ML_POTENTIAL_EXIT_MODE=shadow|apply|off` (default **shadow**). Sim mcap/trending can persist `effective_exit` when `apply`; live never. See [reloadsol_engine_strategies_and_ml.md](./reloadsol_engine_strategies_and_ml.md).

### Server checklist (after deploying Phase B)

1. `git pull` → `npm run docker:deploy:web` (cron unchanged unless Go touched)
2. `.env`: `ML_POTENTIAL_ARTIFACT_DIR=/app/ml/artifacts/v2-potential`, volume `./ml/artifacts:/app/ml/artifacts:ro`, **`ML_POTENTIAL_EXIT_MODE=shadow`** first
3. Restart web after new potential ONNX: `docker restart reloadsol-web` (no hot-reload for potential)
4. Workers ok: `mcap_tracker_sim_track`, `trending_tracker` on cron `:8080`
5. Smoke: trigger mcap sim-track; open buy `entry_features` has `ml_potential_*` + `ml_exit_*`; with `apply`, confirm `effective_exit` and closes use it
6. Optional retrain: `npm run ml:export` → `ml:train-potential` on host → restart web
7. Keep `ML_GATE_MODE` / `ML_PATTERN_MODE` at **shadow** until `*_ready`
8. Only flip `ML_POTENTIAL_EXIT_MODE=apply` after reviewing `[ml-potential-exit:counterfactual]` logs — or use Strategy Admin → Config → **ML2 Exit Overlay** override (requires confirm; sim only)

### Phase 3 — ML2 exit ops

- Edit tier TP/SL table in Admin; saved to `strategy_definitions` / `ml2_exit_overlay`.
- Optional dry-run train: `ML_POTENTIAL_MIN_ROWS=15` (warns below 30).
- Apply via Admin override or env after Exit TP/SL badge review.

### After deploy — re-export training data

Export recovery (aliases + `token_age_hours` derive) is in web + `ml/features.py`. On the VPS host:

```bash
export API_BASE_URL=http://127.0.0.1 TRENDING_TRACKER_SECRET=...
npm run ml:export
npm run ml:check-potential
# compare skipped_incomplete vs prior run; train only when Ready: True (≥30 gate=1)
```

Strategy Admin → Reports now shows Gate / Potential / Exit TP/SL on outcomes that stamped ML shadow fields.

## Pattern ML (primary focus — 24h mcap + social cohorts)

Separate from sim-outcome gate — labels come from `mcap_social_pattern_24h` (winner ≥120% growth, loser &lt;80%).

- Pattern DB refreshes automatically via social rollup cron (~every 5 min).
- Check counts: `/dev/social` → **24h Patterns** or `GET /api/mcap-patterns/stats`.
- Target **30+ winners and 30+ losers** before training (`train_ready`).
- **Daily auto-train (03:00 UTC):** host cron runs `npm run ml:pattern-daily` (export → check → train if ready → reload ONNX).
  - Install once on VPS: `bash scripts/install-ml-pattern-cron.sh`
  - Deploy web after pull so `/api/ml/pattern/reload` is available
  - Manual test: `bash scripts/ml-pattern-daily.sh --dry-run` then `bash scripts/ml-pattern-daily.sh`
  - Logs: `logs/ml-pattern-daily.log`; pipeline state: `ml/artifacts/pattern-gate/pipeline_state.json`
  - Status **`partial`** when &lt;30 winners or &lt;30 losers is normal — export still runs; train waits for `ready`
- Manual export/train: `API_BASE_URL=http://127.0.0.1 npm run ml:export-patterns` → `npm run ml:train-pattern`
- Check: `npm run ml:check-pattern`
- Deploy ONNX to web (`ML_PATTERN_ARTIFACT_DIR=/app/ml/artifacts/pattern-gate`); default **`ML_PATTERN_MODE=shadow`**.
- Shadow fields on sim buys: `ml_pattern_p_winner`, `ml_pattern_predicted` — review in Strategy Admin → **Pattern ML** and **24h cohort** columns.
- Do **not** set `ML_PATTERN_MODE=enforce` until `model.meta.json` → `metrics.pattern_ready === true` (macro-F1 ≥ 0.60 on holdout).
- Review shadow predictions vs 24h cohort labels in `/dev/social` → Patterns (daily job status + model metrics).

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

## Two-stage copy-trade alerts

**Stage 1 — Early Enter** (before growth hits 100%):

- Fired from `GET /api/trading/signals` when `decision=enter` and growth &lt; 100% (not stuck / not `rugged`).
- Telegram: `sendSignalsEarlyEnterAlert`. Toast category `signals_enter` (**Early Enter**).
- Dedup: one per mint per 24h (`signals_enter:{mint}`).
- **Pattern ML shadow (display only):** scores `p_winner` / `predicted` on Stage-1 candidates (5m cache). Shown on Telegram, toast, and Signals **ML** column. Does **not** block alerts — stay shadow until `pattern_ready`.

**Stage 2 — Mcap Sim Open** (confirm after paper open):

- When mcap sim-track opens for **`mcap_enter_first_seen`** or **`mcap_enter_at_80`**.
- Telegram: `sendMcapSimManualTradeAlert`. Toast category `sim_open` (**Mcap Sim Open**).
- Dedup: one per strategy+mint per 24h. Still fires even if Stage 1 already alerted.

Shared:

- **UI:** `McapSimOpenToastHost` in root layout; polls `GET /api/mcap-tracking/sim-open-alerts` every 15s; toast **top-right** (`z-index: 9999`) with **Buy**.
- **Telegram env:** `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALERT_CHAT_ID`; `STRATEGY_TRACK_TELEGRAM_ENABLED` must not be `false`.
- **Workers:** `signals_refresh` (~60s) helps Stage 1; `mcap_tracker_sim_track` for Stage 2.
- **`mcap_enter_at_80` freshness:** skips `milestone_too_old` outside `recencyMinutes` (default 240). Timely opens book `first_mcap × 1.8`; else live `current_mcap`.
- **DB:** apply [`db/init/07-mcap-drop-peak.sql`](../db/init/07-mcap-drop-peak.sql) for `-40%`/`-80%` drop stamps + peak profit columns (auto `rugged` / `potential` labels).

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
| 2026-07-09 | Stage-1 Pattern ML shadow score on Early Enter (Telegram/toast/Signals ML column; never gates) |
| 2026-07-09 | Two-stage alerts (Early Enter + Sim Open); drop -40/-80 + peak profit milestones; auto rugged/potential labels |
| 2026-07-09 | Global sim-open toasts; at_80 skips stale milestones + uses live entry mcap when late; predictive ML UI toasts removed |
| 2026-07-05 | Pattern ML pipeline: 24h cohort export/train, shadow scorer on mcap sim-track, UI feedback columns; Supabase cut off, reloadsol_db only |
| 2026-06-28 | Social TTL cleanup + manual `/dev/social` refresh; `social_overlap` on entry features; L2 enforce wired (default shadow) |
| 2026-06-28 | Two-stage ML: v2-gate binary + v2-potential tiers; shadow ONNX on mcap sim-track |
| 2026-06-28 | Fixed signals sim PnL (mcap vs price); symbol backfill from `token_mcap_tracking`; versioned ML export + gate_ready in train meta |
