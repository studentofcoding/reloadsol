# File: /Users/gic_owner/Desktop/Personal/project_discussion/buy_bulk/docs/HOW_WE_GET_THE_SIGNALS_SUMMARY.md

# Signals Pipeline — Core Summary

## Overview
- Combines tracked market-cap data with price feeds to produce actionable signals.
- Uses statistical anomaly detection and technical momentum rules; not machine learning.
- Surfaces risk-adjusted insights and threshold-based alerts via API and Discord.

## Components
- `mcap-tracker`: Tracks tokens’ market cap, growth milestones, and notifications.
- `trending-tracker`: Ingests trending tokens, applies filters and risk heuristics, supports simulation/live modes.
- `analytics/token`: Enriches tokens with z-score anomalies, MACD-like momentum, liquidity and risk scoring.

## Data Sources
- `Supabase` mcap snapshots for historical and latest tracking.
- `Jupiter` price API (`/v4/price`) for live USD prices and optional volume.

## Analytics Methods
- Anomaly detection: Rolling z-score over mcap; flags positive/negative/neutral anomalies.
- Momentum analysis: EMA/MACD histogram and acceleration; detects bullish/bearish breakouts.
- Risk score: Heuristic combination of market-cap tiers, z-score magnitude, and momentum strength.

## APIs & Flow
- `POST /api/analytics/token`: Enriches tokens with z-score, momentum, price, liquidity, risk.
- `GET /api/trending/stats`: Aggregated trending performance; winners/losers cohorts.
- `GET /api/mcap-tracking`: Tracked tokens and bucketed stats for visualization.

## Notifications & Trading
- Discord alerts on growth milestones (80%/120%/200%) and trading events.
- Simulation vs live trading toggle for operational safety and testing.
- Heartbeat and gating to reduce noise: min-change thresholds, stuck detection, stop-loss guard.

## AI Classification
- Type: Rule-based quantitative analytics with classical statistics.
- No ML training/inference loop, no feature store, no model deployment.

## Key References
- Z-score detector: `src/utils/algo/anomaly-detection.ts:9`, detection map `src/utils/algo/anomaly-detection.ts:51`
- Momentum analyzer (EMA/MACD): `src/utils/algo/momentum-analysis.ts:56`, signals `src/utils/algo/momentum-analysis.ts:97`
- Token enrichment API: price fetch `src/app/api/analytics/token/route.ts:225`, z-score `src/app/api/analytics/token/route.ts:315`, momentum `src/app/api/analytics/token/route.ts:335`, risk `src/app/api/analytics/token/route.ts:426`, response `src/app/api/analytics/token/route.ts:165`
- MCap tracking & notifications: config `src/utils/mcap-tracker.ts:54`, thresholds `src/utils/mcap-tracker.ts:135`
- Bulk tracking in trending flow: `src/app/api/trending/route.ts:1226`
- Trending risk assessment (heuristics): `src/utils/risk-assessment.ts:218`
- mcap-tracker UI: query/refresh `src/app/dev/mcap-tracker/page.tsx:720`, visualization `src/app/dev/mcap-tracker/page.tsx:1304`, analytics render `src/app/dev/mcap-tracker/page.tsx:2517`
- trending-tracker UI: stats `src/app/dev/trending-tracker/page.tsx:302`, toggles `src/app/dev/trending-tracker/page.tsx:421`, trading mode `src/app/dev/trending-tracker/page.tsx:570`

## Summary
- Signals are derived from deterministic quantitative rules: z-score anomalies, MACD-based momentum, and structured risk heuristics.
- The system integrates Supabase tracking with Jupiter prices to produce ranked, risk-aware insights and operational alerts.