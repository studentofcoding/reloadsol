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

## Phase 2

- Wire Signals scoring weights and DLMM thresholds into `strategy_definitions`.
- Export outcomes CSV + baseline model comparison by `strategy_id`.
