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

- Initial and periodic fetch:
  - Calls `GET /api/mcap-tracking?action=list` with filters, pagination, and a PnL range (`minPnl`, `maxPnl`).
  - Refreshes every ~30s to keep stats and tokens current.
  - Displays any server-provided toasts via `pushToasts`.

- PnL Toast Range:
  - Dual controls for `Min` and `Max` (default 20–30%).
  - Sends as `minPnl` and `maxPnl` in requests; the server only emits “High Performers”/“PnL Threshold Reached” toasts for tokens in this range.

- Per-token refetch:
  - Opening a token’s chart triggers `GET /api/mcap-tracking?action=refetch&token=...&pnlThreshold=min&maxPnl=max`.
  - On success, displays any toasts, merges fresh `current_mcap` and `mcap_growth_percent` into the local token, and re-fetches the list to refresh stats and finished status.
  - Refetch is disabled for tokens marked `is_finished`.

- Toasts rendering:
  - Renders clickable token items linking to `/chart/${address}`.
  - Auto-dismisses after a delay; hover pauses the timer.

## API Behavior (`route.ts`)

- `GET?action=list`
  - Reads from Supabase (`token_mcap_tracking`) with filters: `search`, `sortBy`, `sortOrder`, `minGrowth`, `maxGrowth`, `minMcap`, `maxMcap`, `excludeZeroPnl`, `timeFilter`, `performanceFilter`.
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

- `POST` (bulk tracking)
  - Body: `{ tokens: Array<{ address, symbol, mcap }> }` plus optional query `pnlThreshold` (min) and `maxPnl`.
  - Loops over tokens and calls `trackTokenMcap(...)` for each (DB writes), returns per-token results and toasts.

- Other actions
  - `GET?action=health`: returns tracking health stats.
  - `GET?action=cleanup&days=N`: deletes old records older than `N` days.

## Data Model (Supabase — `token_mcap_tracking`)

- Core fields: `token_address`, `token_symbol`, `first_mcap`, `current_mcap`, `mcap_growth_percent`, `first_seen_at`, `last_updated_at`.
- Milestones: `when_reach_80mc`, `when_reach_120mc`, `when_reach_200mc`.
- Status: `is_tracking_stuck` and inferred finished state (via API based on `MAX_TRACKING_AGE_MS`).

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

## Example Requests

- List (page snapshot, no write):
  - `GET /api/mcap-tracking?action=list&minPnl=20&maxPnl=30&limit=100&sortBy=last_updated_at&sortOrder=desc&excludeZeroPnl=false&timeFilter=all&performanceFilter=all`

- Refetch (per-token write):
  - `GET /api/mcap-tracking?action=refetch&token=So11111111111111111111111111111111111111112&pnlThreshold=20&maxPnl=30`

- Track (single write):
  - `GET /api/mcap-tracking?action=track&token=So11111111111111111111111111111111111111112&symbol=SOL&mcap=150000&pnlThreshold=20&maxPnl=30`

- Bulk (multiple writes):
  - `POST /api/mcap-tracking?pnlThreshold=20&maxPnl=30`
  - Body: `{"tokens":[{"address":"...","symbol":"...","mcap":123456}]}`

## Key Takeaways

- The list endpoint reads tracked data and enriches it with live `mcap`/`price` for display, but it does not write to the database.
- Actual tracking updates (DB writes) occur via `track`, `refetch`, and bulk `POST`, using the latest `mcap` as the primary driver of growth and notifications.