# Trending Tracker Documentation

## Overview

The **Trending Tracker** (`src/app/(trade)/dev/trending-tracker/page.tsx`) is a comprehensive dashboard for monitoring, tracking, and executing trades on trending Solana tokens. It integrates real-time data fetching, strategy-based automation, and detailed performance analytics, backed by Supabase for data persistence.

## Architecture & Workflow

### 1. Frontend: The Dashboard
**File:** `src/app/(trade)/dev/trending-tracker/page.tsx`

The page serves as the command center, featuring:
- **Tabbed Interface**: 
  - **Overview**: High-level stats (Win Rate, Top Performers).
  - **Tracking**: Live list of currently monitored tokens.
  - **Winners/Losers**: Historical performance of completed trades.
- **State Management**: Uses `useState` for filters (search, status, sorting) and pagination.
- **Data Fetching**: Powered by the `useTrendingStats` hook.

### 2. Data Fetching Layer
**Hook:** `src/hooks/useTrendingStats.ts`
**Endpoint:** `/api/trending/stats`

- **Mechanism**: Uses `React Query` to fetch data every 30 seconds (auto-refresh).
- **Data Source**: The API aggregates data from Supabase tables:
  - `trending_token_tracker`: Stores individual token data.
  - `trending_token_summary`: Stores daily performance snapshots.
- **Logic**:
  - Fetches active tokens (`status = 'tracking'`).
  - Fetches recent history (last 7 days).
  - Calculates live statistics (Win Rate, Avg Gain, etc.) on the fly.

### 3. Tracking & Trading Workflow
**Endpoint:** `/api/trending/track` (POST)
**File:** `src/app/api/trending/track/route.ts`

When a token is added to the tracker (manually or via bot):

1.  **Request Handling**: The API accepts the token address and configuration.
2.  **Strategy Selection**: Supports strategies like `ATT` (Auto-Trending), `lowcap_moonbag`, etc.
3.  **Supabase Insertion**:
    - A record is created in `trending_token_tracker` with status `tracking`.
    - Initial price and metadata are recorded.
4.  **Trade Execution (Real vs. Simulation)**:
    - **Simulation**:
        - Calls `trackBotOperation` with `is_simulation: true`.
        - Records the "buy" in the PnL system without spending real SOL.
    - **Real Trade**:
        - Uses `Shyft` RPC and `Jupiter` to execute the swap.
        - Verifies transaction success on-chain.
        - Records the "buy" with the transaction signature.

### 4. Data Persistence (Supabase)

The system uses two primary Supabase tables (environment-aware: `_dev` vs `prod`):

#### A. `trending_token_tracker`
Stores the lifecycle of each tracked token.
- **Key Fields**:
  - `token_address`, `symbol`, `name`
  - `initial_price_usd`, `last_price_usd`, `peak_price_usd`
  - `current_gain_percentage`, `peak_gain_percentage`
  - `status`: `waiting`, `tracking`, `won`, `lost`, `skipped`
  - `organic_score`, `market_cap`

#### B. `trending_token_summary`
Stores daily aggregated performance stats.
- **Key Fields**:
  - `period_start`, `period_end`
  - `total_tokens_tracked`, `won_tokens`, `lost_tokens`
  - `win_rate`, `avg_peak_gain`

### 5. PnL & Trade Recording
**Utility:** `src/utils/trading-tracker.ts`
**Endpoint:** `/api/trending/records`

Separate from the "trending" status, every trade (buy/sell) is recorded for Profit & Loss (PnL) analysis.

- **Dual-Write**: Trades are saved to local storage (offline cache) and sent to the backend API.
- **Bot Integration**: The `trackBotOperation` function in `track/route.ts` automatically calls `tradingTracker.trackOperation`.
- **Syncing**: The frontend listens for updates via Server-Sent Events (SSE) at `/api/trading/subscribe` to update the UI immediately after a bot trade.

### 6. Automation & Strategies

- **Bot Operations**: Located in `src/app/api/trending/track/route.ts`.
- **Logic**:
  - `trackBotOperation`: Central function to log simulated or real trades.
  - **PnL Sync**: Triggers `triggerPnLSync` to notify the UI of new trades.
  - **Discord**: Sends webhooks for significant events (New Track, Win, Loss).

## Summary of Data Flow

1.  **User/Bot** -> `POST /api/trending/track` -> **Supabase** (`trending_token_tracker`).
2.  **System** -> Executes Trade/Sim -> **PnL API** (`/api/trading/records`).
3.  **Frontend** -> `useTrendingStats` -> `GET /api/trending/stats` -> **Supabase**.
4.  **Real-time** -> `SSE` -> Frontend Updates PnL.
