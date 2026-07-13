# MCap Tracker — Update Flow and API Guide

## Overview

- The MCap Tracker consists of a client page (`src/app/dev/mcap-tracker/page.tsx`) and an API (`src/app/api/mcap-tracking/route.ts`).
- It displays tracked tokens, emits informative toasts, and lets you refetch per-token market caps.
- Database writes happen only in tracking/refetch endpoints; the list endpoint reads and may enrich values with live data.

## What Triggers Updates?

- Updates are primarily driven by market cap (`mcap`) readings, not price alone.
- The API refetch flow pulls current `mcap` (and `price`) from the trending API, then persists with `trackTokenMcap(...)`.
- Growth percentages are calculated from `first_mcap` and the latest `current_mcap`.

## Client Page Flow (`page.tsx`)

- **Initial and periodic fetch:**
  - Calls `GET /api/mcap-tracking?action=list` with filters, pagination, and a PnL range (`minPnl`, `maxPnl`).
  - Refreshes every ~30s to keep stats and tokens current.
  - Displays any server-provided toasts via `pushToasts`.

- **UI Components:**
  - **DailyRankingVisualization:** Displays daily performance rankings including "Top Gainers", "Highest Market Cap", and "Top Multipliers (>100%)". It supports filtering by date (Today, Yesterday, etc.) and provides a breakdown of gainers vs losers.
  - **PnlDistributionChart:** Visualizes the distribution of PnL across tracked tokens, showing Win/Loss percentages and detailed range buckets (e.g., "-50% to 0%", "100% to 200%").

- **PnL Toast Range:**
  - Dual controls for `Min` and `Max` (default 20–30%).
  - Sends as `minPnl` and `maxPnl` in requests; the server only emits “High Performers”/“PnL Threshold Reached” toasts for tokens in this range.

- **Per-token refetch:**
  - Opening a token’s chart triggers `GET /api/mcap-tracking?action=refetch&token=...&pnlThreshold=min&maxPnl=max`.
  - On success, displays any toasts, merges fresh `current_mcap` and `mcap_growth_percent` into the local token, and re-fetches the list to refresh stats and finished status.
  - Refetch is disabled for tokens marked `is_finished`.

- **Toasts rendering:**
  - Renders clickable token items linking to `/chart/${address}`.
  - Auto-dismisses after a delay; hover pauses the timer.
  - **Deduplication:** Toasts are deduplicated client-side and server-side within a 30s window to prevent spam.

## API Behavior (`route.ts`)

- `GET?action=list`
  - Reads from Postgres `token_mcap_tracking` with filters: `search`, `sortBy`, `sortOrder`, `minGrowth`, `maxGrowth`, `minMcap`, `maxMcap`, `excludeZeroPnl`, `timeFilter`, `performanceFilter`.
  - **Limit:** Explicitly sets a high limit of **100,000** records for statistics queries to ensure comprehensive analysis.
  - **Stats:** Calculates enhanced statistics including:
    - PnL Time Windows (Peak buy/sell hours).
    - MCap Range Analysis (Risk/Reward metrics per bucket).
    - 30-Day PnL Summary.
  - Optionally fetches live trending data to prefer current `mcap` and compute refreshed `mcap_growth_percent` for the response snapshot (no DB write).
  - Emits a “High Performers” toast listing all tokens whose refreshed growth is within `[minPnl, maxPnl]`.
  - Returns: `data` (enhanced tokens), `pagination`, `stats`, and `toasts`.

- `GET?action=track`
  - Inputs: `token`, `symbol`, `mcap`, optional `pnlThreshold` (min) and `maxPnl`.
  - Persists via `trackTokenMcap(token, symbol, mcap)` (DB write), returns tracking result and toasts.
  - Emits “New Token Tracked” and “PnL Threshold Reached” if growth falls within `[minPnl, maxPnl]`.

- `GET?action=refetch`
  - Inputs: `token`, optional `pnlThreshold` (min) and `maxPnl`.
  - Fetches current token info from trending (`mcap`, `price`), then persists via `trackTokenMcap(...)`.
  - Emits “New Token Tracked” and/or “PnL Threshold Reached” based on growth within `[minPnl, maxPnl]`.

- `GET?action=health`
  - Returns tracking health statistics, including:
    - Health percentage (target 99%).
    - Count of zero-growth tokens.
    - Count of recently updated tokens.
  - Provides recommendations if health is low.

- `GET?action=cleanup`
  - Inputs: `days` (default 30).
  - Deletes records older than `N` days to maintain database performance.

- `POST` (bulk tracking)
  - Body: `{ tokens: Array<{ address, symbol, mcap }> }` plus optional query `pnlThreshold` (min) and `maxPnl`.
  - Loops over tokens and calls `trackTokenMcap(...)` for each (DB writes), returns per-token results and toasts.

## Data Model (Postgres — `token_mcap_tracking`)

- Core fields: `token_address`, `token_symbol`, `first_mcap`, `current_mcap`, `mcap_growth_percent`, `first_seen_at`, `last_updated_at`.
- Milestones: `when_reach_80pct`, `when_reach_120pct`, `when_reach_200pct`.
- Status: `is_tracking_stuck` and inferred finished state (via API based on `MAX_TRACKING_AGE_MS`).

## Pattern ML + sim-track

- **24h cohort labels:** social rollup cron (~5m) writes `mcap_social_pattern_24h` (winner ≥120%, loser &lt;80%).
- **Training export:** `GET /api/mcap-patterns/training-export` (auth: `TRENDING_TRACKER_SECRET`).
- **Stats:** `GET /api/mcap-patterns/stats` — cohort counts, `patternModelReady`.
- **Sim workers:** `mcap_tracker_sim_open` → `POST /api/mcap-tracking/sim-track?phase=open` (~15s); `mcap_tracker_sim_track` → `?phase=manage` (~120s). Opens book live `current_mcap`. Pattern ML shadow (`ml_pattern_*`) on entry.
- **Ops:** see [OPERATOR_STATE.md](./OPERATOR_STATE.md), [ARCHITECTURE_SUMMARY.md](./ARCHITECTURE_SUMMARY.md).

## Notifications

- “High Performers” toast:
  - Emitted in `list` for tokens between `minPnl` and `maxPnl`; includes clickable `items` with `symbol`, `address`, `growthPercent`.

- “New Token Tracked” toast:
  - Emitted when a token is first persisted by `track`/`refetch`/`bulk`.

- “PnL Threshold Reached” toast:
  - Emitted when `growthPercent` is within `[minPnl, maxPnl]`.

## Environment Variables

- `NEXT_PUBLIC_MCAP_PNL_TOAST_THRESHOLD` — default `minPnl`.
- `NEXT_PUBLIC_MCAP_PNL_TOAST_MAX` — default `maxPnl`.
- `API_HOST` or `NEXT_PUBLIC_BASE_URL` — base URL for calling internal APIs, including trending.
- `MCAP_PNL_TOAST_THRESHOLD` — server-side fallback for `minPnl`.
- `MCAP_TOAST_DEDUP_WINDOW_MS` — Deduplication window for toasts (default 30000ms).

## Example Requests

- List (page snapshot, no write):
  - `GET /api/mcap-tracking?action=list&minPnl=20&maxPnl=30&limit=100&sortBy=last_updated_at&sortOrder=desc&excludeZeroPnl=false&timeFilter=all&performanceFilter=all`

- Refetch (per-token write):
  - `GET /api/mcap-tracking?action=refetch&token=So11111111111111111111111111111111111111112&pnlThreshold=20&maxPnl=30`

- Track (single write):
  - `GET /api/mcap-tracking?action=track&token=So11111111111111111111111111111111111111112&symbol=SOL&mcap=150000&pnlThreshold=20&maxPnl=30`

- Health Check:
  - `GET /api/mcap-tracking?action=health`

- Cleanup:
  - `GET /api/mcap-tracking?action=cleanup&days=60`

## Key Takeaways

- The list endpoint reads tracked data and enriches it with live `mcap`/`price` for display, but it does not write to the database.
- Actual tracking updates (DB writes) occur via `track`, `refetch`, and bulk `POST`, using the latest `mcap` as the primary driver of growth and notifications.
- The system supports high-volume analysis with a 100k record limit for statistics and optimized batching for updates.
