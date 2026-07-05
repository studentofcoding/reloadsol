# Signals Pipeline — Core Summary

> **Note (Jul 2026):** Production DB is Postgres `reloadsol_db` (Docker). Supabase is no longer used. See [algo_overview.md](./algo_overview.md) for current strategy flows.

## Overview
- Combines tracked market-cap data with price feeds to produce actionable signals.
- Uses statistical anomaly detection and technical momentum rules; not machine learning.
- Surfaces risk-adjusted insights and threshold-based alerts via API and Discord.
- **Rug Pull Protection**: integrated checks for sudden market cap drops.

## Components
- `mcap-tracker`: Tracks tokens’ market cap, growth milestones, and notifications.
- `trending-tracker`: Ingests trending tokens, applies filters and risk heuristics, supports simulation/live modes.
- `analytics/token`: Enriches tokens with z-score anomalies, MACD-like momentum, liquidity and risk scoring.
- `trading-signals`: Computes actionable buy/sell signals based on growth, recency, and specific strategies (e.g., "sell_over_100").

## Data Sources
- Postgres `token_mcap_tracking` for historical and latest tracking.
- `Jupiter` price API (`/v4/price`) for live USD prices and optional volume.
- `Trending API`: Used for real-time market cap verification during rug pull checks.

## Analytics Methods
- **Anomaly detection**: Rolling z-score over mcap; flags positive/negative/neutral anomalies.
- **Momentum analysis**: EMA/MACD histogram and acceleration; detects bullish/bearish breakouts.
- **Risk score**: Heuristic combination of market-cap tiers, z-score magnitude, and momentum strength.
- **Scoring & Decision Engine**:
  - **Base Score**: Derived from current growth %.
  - **Boosts**: Recency (new tokens), Thresholds (80/120/200%), Speed-to-target.
  - **Penalties**: "Stuck" status, Stop-loss hit, Late-stage entry (>100% growth for certain strategies).
  - **Decisions**: `enter`, `hold`, `exit`, `skip`.

## APIs & Flow
- `POST /api/analytics/token`: Enriches tokens with z-score, momentum, price, liquidity, risk.
- `GET /api/trading/signals`: Returns computed signals with scores, decisions, and rationales.
- `GET /api/trending/stats`: Aggregated trending performance; winners/losers cohorts.
- `GET /api/mcap-tracking`: Tracked tokens and bucketed stats for visualization.

## Strategies
- **Default**: Balanced growth and momentum approach.
- **Sell Over 100**: Aggressive profit-taking; penalizes entries after 100% growth, advises exit/hold.

## Notifications & Trading
- Discord alerts on growth milestones (80%/120%/200%) and trading events.
- **Simulation vs Live**: Toggled via API/UI. Live trading requires `TRADING_KEYPAIR_JSON`.
- Heartbeat and gating to reduce noise: min-change thresholds, stuck detection, stop-loss guard.

## AI Classification
- Type: Rule-based quantitative analytics with classical statistics.
- No ML training/inference loop, no feature store, no model deployment.

## Key References
- Z-score detector: `src/utils/algo/anomaly-detection.ts`
- Momentum analyzer: `src/utils/algo/momentum-analysis.ts`
- Signal Computation: `src/app/api/trading/signals/route.ts` (Score & Decision logic)
- Rug Pull Check: `src/app/api/trading/signals/route.ts` (`validateTokensAgainstRugPulls`)
- Token enrichment API: `src/app/api/analytics/token/route.ts`
- Trending flow: `src/app/api/trending/route.ts`
- MCap tracking: `src/utils/mcap-tracker.ts`
