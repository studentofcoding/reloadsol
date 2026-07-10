# Strategy architecture

Three dev surfaces share data but historically used separate strategy config. v1 centralizes **trending bot** strategies in a typed registry + Postgres `strategy_definitions` overrides.

**Data layer:** Docker Postgres **`reloadsol_db`** only (Supabase cut off). Schema: [`db/init/`](../db/init/).

## Domains

| Domain | UI | Execution | Config source (v1) |
|--------|-----|-----------|-------------------|
| Trending bot | `/dev/algo-tester` (observer), `/dev/strategies` (admin) | `POST /api/trending/track` cron | `src/strategies/registry.ts` + `strategy_definitions` DB |
| Signals | `/dev/signals` | Manual buy; `/api/trading/signals` scoring; sim-track cron | registry + DB overrides |
| MCap tracker | `/dev/strategies`, mcap UI | `POST /api/mcap-tracking/sim-track` cron | registry + DB overrides |
| DLMM | `/dev/dlmm` | `POST /api/dlmm/screen`, `/api/dlmm/manage` cron | registry + `dlmm_agent_config` |
| GMGN | `/dev/strategies` | `POST /api/gmgn/sim-track` cron | registry + DB overrides |
| Social / Pattern ML | `/dev/social` | social rollup cron → 24h patterns | `mcap_social_pattern_24h`, rollups |

**Shared engine spine:** all domains adapt to `StrategyParameterSet` + `CanonicalEntryFeatures` ([`canonical-params.ts`](../src/strategies/canonical-params.ts), [`canonical-features.ts`](../src/strategies/canonical-features.ts)). Memecoin opens use [`attachMlEntryShadow`](../src/strategies/ml-entry-shadow.ts) (ML1/ML2 + Pattern shadow). Read-only `canonical` on `GET /api/strategies`. Full plan: [reloadsol_engine_strategies_and_ml.md](./reloadsol_engine_strategies_and_ml.md).

## Trending bot flow

1. Cron calls `POST /api/trending/track`.
2. `refreshTrackStrategyCache()` loads merged registry (code defaults + DB overrides + env activation).
3. **Pre-filter**: union of all active strategy filter bands (fixes multi-strategy using only first strategy).
4. **Assignment**: `assignTokenToStrategy()` per token.
5. Sim/real buy with assigned strategy TP/SL.
6. On full close, `strategy_outcomes` row written for ML comparison later.

## MCap tracker + Pattern ML

1. Cron calls `POST /api/mcap-tracking/sim-track`.
2. Entry templates (`first_seen`, `milestone_80`) from registry + L1 rules.
3. Shadow scorers on open: sim-outcome gate (`ml_gate_*`) + **Pattern ML** (`ml_pattern_*`).
4. Pattern labels from `mcap_social_pattern_24h` (24h winner/loser cohorts) — train via `ml/train_pattern.py`.
5. On sim close → `recordMcapTrackerOutcome`.

See [ARCHITECTURE_SUMMARY.md](./ARCHITECTURE_SUMMARY.md) for Pattern ML ops (primary ML focus).

## Admin

- **Page**: `/dev/strategies` (dev wallet gate)
- **API**: `GET /api/strategies`, `PATCH /api/strategies/[id]`, `GET /api/strategies/outcomes`

Apply schema via [`db/init/`](../db/init/) (`strategy_definitions`, `strategy_outcomes`, `mcap_social_pattern_24h` in migration `06`).

**Full per-strategy reference:** [algo_overview.md](./algo_overview.md) — capture/calculate/result for all 9 strategies, workers, gap diagnosis.

## Phase 2

- Editable Signals + DLMM strategies in `/dev/strategies` (Config tab).
- Automated signals paper trading via `POST /api/signals/sim-track` cron.
- Unified outcomes in `strategy_outcomes` (all domains, `is_simulated` column).
- Reports tab: A/B sim vs live, CSV export, ranking, Pattern ML + 24h cohort columns.
- **Pattern ML (primary):** see [ARCHITECTURE_SUMMARY.md](./ARCHITECTURE_SUMMARY.md), [OPERATOR_STATE.md](./OPERATOR_STATE.md).
- **Sim-outcome ML gate (secondary):** [ML_GATE_PLAN.md](./ML_GATE_PLAN.md) — dataset stats API, training pipeline in `ml/`.
- `POST /api/strategies/[id]/promote` copies winning config after review.
- Optional digest: `STRATEGY_REPORT_DISCORD_ENABLED`, `STRATEGY_REPORT_TELEGRAM_ENABLED`, cron `STRATEGY_REPORT_INTERVAL`.
