# Strategy architecture

Three dev surfaces share data but historically used separate strategy config. v1 centralizes **trending bot** strategies in a typed registry + Supabase overrides.

## Domains

| Domain | UI | Execution | Config source (v1) |
|--------|-----|-----------|-------------------|
| Trending bot | `/dev/algo-tester` (observer), `/dev/strategies` (admin) | `POST /api/trending/track` cron | `src/strategies/registry.ts` + `strategy_definitions` DB |
| Signals | `/dev/signals` | Manual buy; `/api/trading/signals` scoring | Read-only templates in admin |
| DLMM | `/dev/dlmm` | `POST /api/dlmm/screen`, `/api/dlmm/manage` cron | Read-only snapshot in admin; `dlmm_agent_config` |

## Trending bot flow

1. Cron calls `POST /api/trending/track`.
2. `refreshTrackStrategyCache()` loads merged registry (code defaults + DB overrides + env activation).
3. **Pre-filter**: union of all active strategy filter bands (fixes multi-strategy using only first strategy).
4. **Assignment**: `assignTokenToStrategy()` per token.
5. Sim/real buy with assigned strategy TP/SL.
6. On full close, `strategy_outcomes` row written for ML comparison later.

## Admin

- **Page**: `/dev/strategies` (dev wallet gate)
- **API**: `GET /api/strategies`, `PATCH /api/strategies/[id]`, `GET /api/strategies/outcomes`

Run new tables from `supabase/schema.sql` (`strategy_definitions`, `strategy_outcomes`).

**Full algo reference:** [algo_overview.md](./algo_overview.md) — domains, cron workers, outcome recording, gap diagnosis, Workers tab.

## Phase 2

- Editable Signals + DLMM strategies in `/dev/strategies` (Config tab).
- Automated signals paper trading via `POST /api/signals/sim-track` cron.
- Unified outcomes in `strategy_outcomes` (all domains, `is_simulated` column).
- Reports tab: A/B sim vs live, CSV export, ranking.
- **ML gate (Layer 2–3):** see [ML_GATE_PLAN.md](./ML_GATE_PLAN.md) — dataset stats API, training pipeline in `ml/`.
- `POST /api/strategies/[id]/promote` copies winning config after review.
- Optional digest: `STRATEGY_REPORT_DISCORD_ENABLED`, `STRATEGY_REPORT_TELEGRAM_ENABLED`, cron `STRATEGY_REPORT_INTERVAL`.
