# Algo system overview

Central reference for strategy domains, per-strategy capture/calculate/result, Pattern ML, outcomes, cron workers, and gap diagnosis.

**Data layer:** Docker Postgres **`reloadsol_db`** only (Supabase cut off). Schema: [`db/init/`](../db/init/).

See also: [STRATEGY_ARCHITECTURE.md](./STRATEGY_ARCHITECTURE.md), [architecture.md](./architecture.md), [ARCHITECTURE_SUMMARY.md](./ARCHITECTURE_SUMMARY.md), [whole_process.md](./whole_process.md).

---

## Domains

| Domain | Admin / dev UI | Config source | Primary worker |
|--------|----------------|---------------|----------------|
| **trending_bot** | `/dev/algo-tester`, `/dev/strategies` | `src/strategies/registry.ts` + `strategy_definitions` | `POST /api/trending/track` (cron every 5m) |
| **signals** | `/dev/signals`, `/dev/strategies` | registry + DB overrides | `POST /api/signals/sim-track` (cron every 120s default) |
| **mcap_tracker** | `/dev/strategies`, mcap tracker UI | registry + DB overrides | `POST /api/mcap-tracking/sim-track` |
| **dlmm** | `/dev/dlmm`, `/dev/strategies` | registry + `dlmm_agent_config` | `POST /api/dlmm/screen`, `POST /api/dlmm/manage` |
| **social / Pattern ML** | `/dev/social` | rollup + pattern tables | social rollup cron (~5m); labels feed Pattern ML |

**Execution modes** (`strategy_definitions.execution_mode`):

- `sim_only` — paper trades only; included in sim-track / trending sim paths
- `live_only` — real wallet execution; skipped by sim workers
- `ab_parallel` — both sim and live; Reports tab shows A/B pairs for signals/DLMM only (trending bot excluded — no dual-buy)

---

## Strategy registry (9 strategies)

| ID | Domain | Worker | Outcome writer | Default active |
|----|--------|--------|----------------|----------------|
| `att` | trending_bot | trending track | `recordTrendingBotOutcome` | yes |
| `lowcap_moonbag` | trending_bot | trending track | same | yes |
| `scalper` | trending_bot | trending track | same | no |
| `hodl` | trending_bot | trending track | same | no |
| `signals_default` | signals | sim-track | `recordSignalsOutcome` | yes |
| `signals_sell_over_100` | signals | sim-track | same | yes |
| `mcap_enter_first_seen` | mcap_tracker | mcap sim-track | `recordMcapTrackerOutcome` | yes |
| `mcap_enter_at_80` | mcap_tracker | mcap sim-track | same | yes |
| `dlmm_default` | dlmm | dlmm manage | `recordDlmmOutcome` | yes |

Params source: [`src/strategies/registry.ts`](../src/strategies/registry.ts) merged with DB overrides via `load-*.ts` / `merge-*.ts`.

---

## Per-strategy reference

Each subsection: **Capture** (what triggers entry) → **Calculate** (filters/scoring) → **Result** (exit + outcomes).

### `att` (trending_bot)

- **Capture:** `POST /api/trending/track` every 5m → Jupiter trending list (`toptrending/1h`).
- **Calculate:** Union pre-filter across active strategies; `assignTokenToStrategy()`. Filtering: mcap 200k–5M, organic ≥60, priceChange bands, top holders ≤30%.
- **Result:** TP1 45% (sell 90%), TP2 100%, SL -35%, max hold 24h, buy 0.035 SOL → `recordTrendingBotOutcome` on **full** close only.

### `lowcap_moonbag` (trending_bot)

- **Capture:** same worker as `att`.
- **Calculate:** mcap 35k–90k band; wider priceChange6h allowance; organic min 0.
- **Result:** TP1 200% (sell 90%), TP2 400%, TP3 600%, SL -30%, max hold 12h, buy 0.008 SOL.

### `scalper` (trending_bot — inactive default)

- **Capture:** same worker.
- **Calculate:** mcap 300k–4M; priceChange5m dip band (-30% to -10%); organic ≥65.
- **Result:** TP 15/25/40%, SL -15%, max hold 6h.

### `hodl` (trending_bot — inactive default)

- **Capture:** same worker.
- **Calculate:** mcap 1M–10M; organic ≥85; conservative priceChange caps.
- **Result:** TP 100/200/500% (partial sells), SL -60%, max hold 168h.

### `signals_default` (signals)

- **Capture:** `POST /api/signals/sim-track` (~120s); loads tokens from signals scoring pipeline.
- **Calculate:** `scoreSignalsForStrategy`, template `default`, `enterScoreFloor` 50, recency 240m, milestone/speed scoring weights.
- **Result:** Standard exit scoring → `recordSignalsOutcome` on sim close. Sim wallet: `SIGNALS_SIM_WALLET_ADDRESS`.

### `signals_sell_over_100` (signals)

- **Capture:** same worker.
- **Calculate:** template `sell_over_100`; adds `sellOver100LatePenalty` to scoring.
- **Result:** Exits when mcap growth ≥100%, stop-loss, or stuck. **PnL at close uses live token price** (`fetchTokenPricesForTracking`), not mcap growth — rugs can show ~-97% even when mcap growth triggers exit.

### `mcap_enter_first_seen` (mcap_tracker)

- **Capture:** `POST /api/mcap-tracking/sim-track`; candidates from `token_mcap_tracking` via `fetchMcapSimCandidateRows`.
- **Calculate:** `entryTemplate: first_seen`; entry mcap band 30k–2M; L1 rules in `mcap-sim-track.ts`; optional social L1 + ML shadow gates.
- **Result:** SL -50%, TP 200%, max hold 96h, sim buy 0.01 SOL → `recordMcapTrackerOutcome`. Sim wallet: `mcap-tracker-sim`.
- **Pattern ML hook:** shadow scores `ml_pattern_p_winner`, `ml_pattern_predicted` on entry (`entry-pattern-scorer`).
- **Manual copy-trade alert (Stage 2):** on sim open → Telegram (`sendMcapSimManualTradeAlert`) + UI toast (poll `GET /api/mcap-tracking/sim-open-alerts`). Deduped 24h per strategy+mint.
- **Early alert (Stage 1):** Signals `enter` + growth &lt;100% → `sendSignalsEarlyEnterAlert` + Early Enter toast (independent of sim open). Pattern ML shadow (`p_winner`) attached for display only.

### `mcap_enter_at_80` (mcap_tracker — primary thesis)

- **Capture:** same worker.
- **Calculate:** `entryTemplate: milestone_80` — enter when token hits 80% mcap growth milestone.
- **Result:** same exit defaults as `mcap_enter_first_seen`.
- **Pattern ML hook:** same shadow fields on entry.
- **Manual copy-trade alert:** Stage 2 same as `mcap_enter_first_seen`; Stage 1 may have already fired from Signals scoring.

### `dlmm_default` (dlmm)

- **Capture:** `POST /api/dlmm/screen` (candidates) + `POST /api/dlmm/sim-track` (auto deploy) + `POST /api/dlmm/manage` (monitor).
- **Calculate:** Start: min TVL 50k, fee/TVL 0.1, organic ≥50, holders ≥100, `minCandidateScore` 15. End: TP 5%, SL -10%, OOR timeout 16min.
- **Result:** On position close → `recordDlmmOutcome`. Requires `DLMM_AGENT_ENABLED=true`; sim-track skips when `dry_run=false`.

---

## Pattern ML pipeline (primary ML focus)

Separate from sim-outcome gate (Reports labels). Labels from **24h cohort**, not closed sim PnL.

```mermaid
flowchart LR
  Rollup[social rollup ~5m] --> Pat24[mcap_social_pattern_24h]
  Pat24 --> Export[training-export API]
  Export --> Train[ml/train_pattern.py]
  Train --> Shadow[entry-pattern-scorer shadow]
  SimTrack[mcap sim-track] --> Shadow
  SimTrack --> Alerts[mcap-sim-open-alerts]
  Alerts --> SignalsHub[/dev/signals toasts]
```

- **Cohort labels:** winner ≥120% mcap growth, loser &lt;80% (`first_seen_at` in last 24h). Neutral 80–119% not stored.
- **Auto-refresh:** social rollup cron (~5m) — no separate “24h worker”.
- **Export (host):** `API_BASE_URL=http://127.0.0.1 npm run ml:export-patterns`
- **Train (host):** `npm run ml:train-pattern` → `ml/artifacts/pattern-gate/`
- **Shadow:** `ML_PATTERN_MODE=shadow` (default); fields on mcap sim entry features.
- **Enforce:** only when `model.meta.json` → `metrics.pattern_ready === true` (macro-F1 ≥ 0.60).

### Current model baseline (Jul 2026)

| Metric | Value |
|--------|-------|
| `macro_f1` | **0.468** → `pattern_ready: false` |
| Class 1 test recall | **0** (n=8) |
| Train class counts | `{0: 280, 1: 50}` |
| Top features | `log_first_mcap`, `log_mention_count_30m`, `minutes_to_first_mention` |

See [OPERATOR_STATE.md](./OPERATOR_STATE.md) and [ARCHITECTURE_SUMMARY.md](./ARCHITECTURE_SUMMARY.md) for ops detail.

---

## Data model

### `strategy_definitions`

Per-strategy overrides: `is_active`, `execution_mode`, JSON `config`, domain.

### `strategy_outcomes`

Written **only when a position fully closes** (not on open/hold):

- Signals sim (cron): on sim sell in `POST /api/signals/sim-track`
- Signals sim/live (manual UI): on full close via `maybeRecordSignalsOutcome` in `POST /api/trading/records`
- Trending bot: on full close via `finalizeBotPositionClose` (`isFullClose === true`)
- MCap tracker: on sim close via `recordMcapTrackerOutcome`
- DLMM: on position close in `dlmm/actions`

Columns: `strategy_id`, `domain`, `token_address`, `entry_at`, `exit_at`, `pnl_pct`, `status`, `is_simulated`, `features`.

**Sim-outcome ML labeling (Reports → Outcomes):** click a row to open the review modal. Labels persist in `features`:

- `ml_label`: `skip` | `interesting` | `anomaly`
- `ml_condition`: `old_chart` | `price_topped` | `new_chart` (optional)
- `ml_note`, `ml_labeled_at`, `ml_condition_at`

API: `PATCH /api/strategies/outcomes/[id]`. List filters: `GET /api/strategies/outcomes?ml_label=interesting`.

**Pattern ML fields (mcap sim entries):** `ml_pattern_p_winner`, `ml_pattern_predicted` — distinct from sim-outcome gate fields (`ml_gate_*`).

### `trading_records`

Sim wallet for signals: `SIGNALS_SIM_WALLET_ADDRESS` (default `signals-strategy-sim`). MCap sim: `mcap-tracker-sim`.

---

## Flow by domain

### Signals

1. Cron refreshes scoring data (`GET /api/trading/signals` or signals refresh worker).
2. `POST /api/signals/sim-track` (every `SIGNALS_SIM_INTERVAL`, default 120s):
   - Loads active strategies with `execution_mode` in `sim_only` | `ab_parallel`
   - Scores tokens via `scoreSignalsForStrategy`
   - Opens sim buys / closes on `decision === 'exit'`
3. On close → `recordSignalsOutcome` → `strategy_outcomes`

**Manual UI (Live / Board tabs):** sim and live buys set `bot_strategy` to the selected signals strategy. On full close, `POST /api/trading/records` calls `maybeRecordSignalsOutcome`.

### Trending bot

1. Cron `POST /api/trending/track` (every 5m).
2. Union pre-filter across active strategies → `assignTokenToStrategy`.
3. Sim/real buy with strategy TP/SL.
4. On **full** close → `recordTrendingBotOutcome`.

Partial TP sells do not write outcomes until 100% closed.

### MCap tracker sim

1. Cron `POST /api/mcap-tracking/sim-track` (via `mcap_tracker_sim_track` worker).
2. Loads active mcap strategies; evaluates entry templates (`first_seen`, `milestone_80`).
3. L1 rules → social L1 → sim-outcome ML shadow → **Pattern ML shadow** → paper buy.
4. **Stage 1:** `GET /api/trading/signals` (UI + `signals_refresh`) emits Early Enter toast/Telegram when `enter` and growth &lt;100%.
5. **Stage 2:** On sim open for `mcap_enter_first_seen` / `mcap_enter_at_80`: `recordSimOpenAlert` + `sendMcapSimManualTradeAlert`; toast host polls `GET /api/mcap-tracking/sim-open-alerts`.
6. On close → `recordMcapTrackerOutcome`.

### DLMM

1. Cron `POST /api/dlmm/screen` — score pools into `dlmm_candidates`.
2. Cron `POST /api/dlmm/sim-track` — auto-deploy top candidates in `dry_run` when active.
3. Cron `POST /api/dlmm/manage` — monitor open positions; close on end conditions.
4. On close → `recordDlmmOutcome`.

---

## Cron service (Go)

Process: [`main.go`](../main.go) — container `reloadsol-cron`, port **8080** (local: `CRON_PORT`).

`npm run dev` alone does **not** run cron. History gaps usually mean cron is stopped.

**Docker deploy:** frontend-only changes should use `npm run docker:deploy:web` — cron container is not rebuilt or restarted.

### Env vars (common)

| Variable | Default | Worker |
|----------|---------|--------|
| `API_BASE_URL` | production URL | All HTTP calls |
| `TRENDING_TRACKER_SECRET` | — | Auth for trending/signals/mcap sim |
| `SIGNALS_SIM_INTERVAL` | 120 | signals sim-track |
| `SIGNAL_REFRESH_INTERVAL` | 60 | signals refresh |
| `MCAP_TRACKER_SIM_INTERVAL` | 300 | mcap tracker sim-track |
| `SOCIAL_ROLLUP_INTERVAL` | 300 | social rollup + 24h patterns |
| `DLMM_SCREEN_INTERVAL` | 300 | dlmm screen |
| `DLMM_SIM_TRACK_INTERVAL` | 300 | dlmm sim-track |
| `DLMM_MANAGE_INTERVAL` | 60 | dlmm manage |
| `STRATEGY_REPORT_INTERVAL` | 86400 (0=off) | report digest |
| `CRON_SERVICE_URL` | `http://cron:8080` in Docker compose | Next.js proxy to cron |
| `TELEGRAM_BOT_TOKEN` | — | Sim open copy-trade alerts (with `TELEGRAM_ALERT_CHAT_ID`) |
| `TELEGRAM_ALERT_CHAT_ID` | — | Telegram destination for strategy/sim alerts |
| `STRATEGY_TRACK_TELEGRAM_ENABLED` | enabled unless `false` | Gates all strategy track Telegram alerts |

### Endpoints

| Path | Purpose |
|------|---------|
| `GET /health` | Service health + worker snapshot |
| `GET /workers` | Full worker list with real `last_success_at` |
| `POST /trigger/signals-sim-track` | Run signals sim now |
| `POST /trigger/mcap-tracker-sim-track` | Run mcap sim now |
| `POST /trigger/trending` | Run trending track now |
| `POST /trigger/dlmm-screen` | Run DLMM screen now |
| … | See `main.go` for all `/trigger/*` |

**Note:** Go `/trigger/*` endpoints have no auth. The app proxies triggers via `POST /api/workers/trigger`.

### Worker status values

| Status | Meaning |
|--------|---------|
| `ok` | Last success within 2× interval |
| `stale` | No success for > 2× interval |
| `error` | Last run failed after last success |
| `never_run` | Cron up but job never completed |
| `disabled` | Job not scheduled |
| `offline` | Cron service unreachable (UI only) |

---

## Admin UI (`/dev/strategies`)

| Tab | Purpose |
|-----|---------|
| **Config** | Edit strategy params, activation, execution mode |
| **Reports** | Coverage table (all strategies), filters, outcomes pagination, ML review modal, Pattern ML + 24h cohort columns, CSV export |
| **Workers** | Cron online/offline, worker table, domain heartbeat, **Run now** |

### API routes

- `GET /api/strategies` — merged registry
- `GET /api/strategies/reports` — breakdown + `coverage[]`
- `GET /api/strategies/outcomes` — paginated outcomes
- `PATCH /api/strategies/outcomes/[id]` — ML label merge
- `GET /api/mcap-patterns/stats` — 24h cohort counts + pattern model readiness
- `GET /api/workers/status` — cron + DB heartbeat
- `POST /api/workers/trigger` — run worker now (dev only)

---

## Gap diagnosis (e.g. no outcomes after 21 Jun)

1. **Workers tab** — Is cron online? Is `signals_sim_track` or `mcap_tracker_sim_track` stale?
2. **Run now** on the relevant worker — does `last_success_at` update?
3. **Reports coverage** — last exit per strategy; zero trades ≠ broken recording
4. **Open positions** — sim wallet may hold positions; outcomes only on close
5. **`execution_mode: live_only`** or `is_active: false` skips sim
6. **Postgres insert errors** — logged in `[strategies/db] outcome insert failed` (non-fatal)

### Run now vs restart container

- **Run now** (UI): triggers one immediate worker run via Go `/trigger/*`.
- **Restart cron container**: `docker restart reloadsol-cron` — required if the Go process crashed.

---

## Known behavior

- Recent outcomes dominated by `signals_sell_over_100` when that worker runs every ~2–4 min with many sim closes.
- Large negative SIM PnL often reflects dead/rug token prices at exit, not a calculation bug.
- `mcap_tracker` strategies are `sim_only` — they never appear in A/B comparison (signals/DLMM only).
- Pattern ML model currently predicts all losers on holdout — stay shadow until `pattern_ready`.
