# Algo system overview

Central reference for the three strategy domains (trending bot, signals, DLMM), how outcomes are recorded, cron workers, and how to diagnose gaps in history.

See also: [STRATEGY_ARCHITECTURE.md](./STRATEGY_ARCHITECTURE.md), [architecture.md](./architecture.md), [whole_process.md](./whole_process.md).

---

## Three domains

| Domain | Admin / dev UI | Config source | Primary worker |
|--------|----------------|---------------|----------------|
| **trending_bot** | `/dev/algo-tester`, `/dev/strategies` | `src/strategies/registry.ts` + `strategy_definitions` | `POST /api/trending/track` (cron every 5m) |
| **signals** | `/dev/signals`, `/dev/strategies` | registry + DB overrides | `POST /api/signals/sim-track` (cron every 120s default) |
| **dlmm** | `/dev/dlmm`, `/dev/strategies` | registry + `dlmm_agent_config` | `POST /api/dlmm/screen`, `POST /api/dlmm/manage` |

**Execution modes** (`strategy_definitions.execution_mode`):

- `sim_only` — paper trades only; included in sim-track / trending sim paths
- `live_only` — real wallet execution; skipped by sim workers
- `ab_parallel` — both sim and live; Reports tab shows A/B pairs

---

## Strategy registry (7 strategies)

| ID | Domain | Worker | Outcome writer | Default active |
|----|--------|--------|----------------|----------------|
| `att` | trending_bot | trending track | `recordTrendingBotOutcome` | yes |
| `lowcap_moonbag` | trending_bot | trending track | same | yes |
| `scalper` | trending_bot | trending track | same | no |
| `hodl` | trending_bot | trending track | same | no |
| `signals_default` | signals | sim-track | `recordSignalsOutcome` | yes |
| `signals_sell_over_100` | signals | sim-track | same | yes |
| `dlmm_default` | dlmm | dlmm manage | `recordDlmmOutcome` | yes |

---

## Data model

### `strategy_definitions`

Per-strategy overrides: `is_active`, `execution_mode`, JSON `config`, domain.

### `strategy_outcomes`

Written **only when a position fully closes** (not on open/hold):

- Signals sim: on sim sell in `POST /api/signals/sim-track`
- Trending bot: on full close via `finalizeBotPositionClose` (`isFullClose === true`)
- DLMM: on position close in `dlmm/actions`

Columns: `strategy_id`, `domain`, `token_address`, `entry_at`, `exit_at`, `pnl_pct`, `status`, `is_simulated`, `features`.

### `trading_records`

Sim wallet for signals: `SIGNALS_SIM_WALLET_ADDRESS` (default `signals-strategy-sim`). Open positions live here until closed.

---

## Flow by domain

### Signals

1. Cron refreshes scoring data (`GET /api/trading/signals` or signals refresh worker).
2. `POST /api/signals/sim-track` (every `SIGNALS_SIM_INTERVAL`, default 120s):
   - Loads active strategies with `execution_mode` in `sim_only` | `ab_parallel`
   - Scores tokens via `scoreSignalsForStrategy`
   - Opens sim buys / closes on `decision === 'exit'`
3. On close → `recordSignalsOutcome` → `strategy_outcomes`

**`signals_sell_over_100` template:** exits when growth ≥ 100%, stop-loss, or stuck. PnL at close uses live token price (`fetchTokenPricesForTracking`), not mcap growth — rugs can show ~-97% even when mcap scoring still triggers exit.

### Trending bot

1. Cron `POST /api/trending/track` (every 5m).
2. Union pre-filter across active strategies → `assignTokenToStrategy`.
3. Sim/real buy with strategy TP/SL.
4. On **full** close → `recordTrendingBotOutcome`.

Partial TP sells do not write outcomes until 100% closed.

### DLMM

1. Cron `POST /api/dlmm/screen` — candidate pools.
2. Cron `POST /api/dlmm/manage` — open/close LP positions.
3. On close → `recordDlmmOutcome`.

---

## Cron service (Go)

Process: [`main.go`](../main.go) — container `reloadsol-cron`, port **8080** (local: `CRON_PORT`).

`npm run dev` alone does **not** run cron. History gaps usually mean cron is stopped.

**Docker deploy:** frontend-only changes should use `npm run docker:deploy:web` — cron container is not rebuilt or restarted. Start cron with `npm run docker:up:cron` or `npm run docker:dev:full` when testing Workers tab locally.

### Env vars (common)

| Variable | Default | Worker |
|----------|---------|--------|
| `API_BASE_URL` | production URL | All HTTP calls |
| `TRENDING_TRACKER_SECRET` | — | Auth for trending/signals sim |
| `SIGNALS_SIM_INTERVAL` | 120 | signals sim-track |
| `SIGNAL_REFRESH_INTERVAL` | 60 | signals refresh |
| `DLMM_SCREEN_INTERVAL` | 300 | dlmm screen |
| `DLMM_MANAGE_INTERVAL` | 60 | dlmm manage |
| `STRATEGY_REPORT_INTERVAL` | 86400 (0=off) | report digest |
| `CRON_SERVICE_URL` | `http://cron:8080` in Docker compose (web→cron); `http://127.0.0.1:8080` local | Next.js proxy to cron |

### Endpoints

| Path | Purpose |
|------|---------|
| `GET /health` | Service health + worker snapshot |
| `GET /status` | Basic status |
| `GET /workers` | Full worker list with real `last_success_at` |
| `POST /trigger/signals-sim-track` | Run signals sim now |
| `POST /trigger/trending` | Run trending track now |
| `POST /trigger/dlmm-manage` | Run DLMM manage now |
| … | See `main.go` for all `/trigger/*` |

**Note:** Go `/trigger/*` endpoints currently have no auth. The app proxies triggers via `POST /api/workers/trigger` (dev-gated) so the browser never hits cron directly.

### Worker status values

| Status | Meaning |
|--------|---------|
| `ok` | Last success within 2× interval |
| `stale` | No success for > 2× interval |
| `error` | Last run failed after last success |
| `never_run` | Cron up but job never completed |
| `disabled` | Job not scheduled (e.g. `STRATEGY_REPORT_INTERVAL=0`) |
| `offline` | Cron service unreachable (UI only) |

---

## Admin UI (`/dev/strategies`)

| Tab | Purpose |
|-----|---------|
| **Config** | Edit strategy params, activation, execution mode |
| **Reports** | Coverage table (all 7 strategies), filters, outcomes pagination, CSV export |
| **Workers** | Cron online/offline, worker table, domain heartbeat, **Run now** |

### API routes

- `GET /api/strategies` — merged registry
- `GET /api/strategies/reports` — breakdown + `coverage[]`
- `GET /api/strategies/outcomes` — paginated outcomes
- `GET /api/workers/status` — cron + DB heartbeat
- `POST /api/workers/trigger` — run worker now (dev only)

---

## Gap diagnosis (e.g. no outcomes after 21 Jun)

1. **Workers tab** — Is cron online? Is `signals_sim_track` stale?
2. **Run now** on `signals_sim_track` — does `last_success_at` update?
3. **Reports coverage** — last exit per strategy; zero trades ≠ broken recording
4. **Open positions** — sim wallet may hold positions; outcomes only on close
5. **`execution_mode: live_only`** or `is_active: false` skips sim
6. **Supabase insert errors** — logged in `[strategies/db] outcome insert failed` (non-fatal)

### Run now vs restart container

- **Run now** (UI): triggers one immediate worker run via Go `/trigger/*`.
- **Restart cron container**: `docker restart reloadsol-cron` — required if the Go process crashed; not available from the web UI.

---

## Known behavior

- Recent outcomes dominated by `signals_sell_over_100` when that worker runs every ~2–4 min with many sim closes.
- Large negative SIM PnL often reflects dead/rug token prices at exit, not a calculation bug.
- UI previously showed only the latest 50 outcomes globally; Reports tab now filters by strategy with pagination.
