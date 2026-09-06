# ReloadSOL — Docs

Condensed, codebase-accurate entry points into the ReloadSOL trading platform. Each
numbered doc is the single "start here" for its category; the deeper per-topic docs in
this folder remain authoritative references.

## Categories

| # | Doc | Covers |
|---|-----|--------|
| 01 | [01-product-and-trading.md](./01-product-and-trading.md) | What ReloadSOL is; networks (sol · robinhood); trading surfaces (bulk buy/sell, swap, chart buy, PnL/history); swap execution per network+wallet; receipt-gated confirmation lifecycle; PnL/history concepts |
| 02 | [02-architecture-and-data.md](./02-architecture-and-data.md) | Docker topology; Postgres `reloadsol_db` schema + Redis cache; `TrackingRecord` model; representative data flows (RPC, pricing, swaps, records, worker cycles); deploy model |
| 03 | [03-strategies-and-automation.md](./03-strategies-and-automation.md) | What a "strategy" is (definition + worker + outcome); worker inventory; sim vs real; kill switch / circuit breaker / re-entry guards; where the code lives. Current algo snapshot: [DECISION_MACHINE.md](./DECISION_MACHINE.md) |
| 04 | [04-machine-learning.md](./04-machine-learning.md) | ML purpose & consumers; `ml/` layout; export→train→evaluate→ship→runtime ONNX; labels & coverage; baselines; shadow-vs-enforce |
| 05 | [05-operations-and-deployment.md](./05-operations-and-deployment.md) | Env / preflight (73 keys); Docker stack table; deploy runbook (`docker-deploy.sh`); ops runbook (migrations, backup, circuit breaker, PnL automation, common failures) |

## Diagrams

| Diagram | Content |
|---------|---------|
| [diagrams/01-trading-surfaces.html](./diagrams/01-trading-surfaces.html) | Trading surfaces → execution → records/SSE |
| [diagrams/02-confirmation-lifecycle.html](./diagrams/02-confirmation-lifecycle.html) | On-chain receipt-gated trade confirmation |
| [diagrams/03-system-architecture.html](./diagrams/03-system-architecture.html) | System architecture on one VPS |
| [diagrams/04-strategy-engine.html](./diagrams/04-strategy-engine.html) | Strategy engine spine |
| [diagrams/05-ml-pipeline.html](./diagrams/05-ml-pipeline.html) | ML pipeline |
| [diagrams/06-deploy-and-ops.html](./diagrams/06-deploy-and-ops.html) | Web deploy runbook |

## Deep references (kept as-is)

- Product/flows: `whole_process.md`, `SWAP_AND_CLOSE_FLOW.md`, `Overview.md`, `trending_tracker.md`, `mcap-tracker.md`
- Architecture: `ARCHITECTURE_SUMMARY.md`, `architecture.md`, `API_ARCHITECTURE_SUMMARY.md`
- Strategies: `DECISION_MACHINE.md` (Solana + RH algo current state), `algo_overview.md`, `STRATEGY_ARCHITECTURE.md`, `reloadsol_engine_strategies_and_ml.md`, `GMGN_STRATEGY.md`, `sol_arbitrations.md`, `MCAP_RANGE_RISK_REWARD.md`, `HOW_WE_GET_THE_SIGNALS.md`, `FIX_STATUS_CONSTRAINT_README.md`
- ML: `deep_dive_ml.md`, `ML_GATE_PLAN.md`, `OPERATOR_STATE.md`
- Deprecated/superseded docs moved to [`_archive/`](./_archive/) — kept for history only.
