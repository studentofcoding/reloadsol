# Trending Tracker Documentation

## Overview

The **Trending Tracker** (`src/app/(trade)/dev/trending-tracker/page.tsx`) is a comprehensive dashboard for monitoring, tracking, and executing trades on trending Solana tokens. It integrates real-time data fetching, strategy-based automation, and detailed performance analytics, backed by Supabase for data persistence.

## Architecture & Workflow

### 1. Frontend: The Dashboard
**File:** `src/app/(trade)/dev/trending-tracker/page.tsx`

The page serves as the command center with a split workflow for **Analysis** and **Action**:

- **Tabbed Interface**:
  - **Overview**: High-level stats (Win Rate, Top Performers) and a list of top winners.
  - **Tracking**: Live list of currently monitored tokens.
  - **Winners/Losers**: Historical performance of completed trades.
- **Interaction Logic**:
  - **Row Click (Analysis)**: Clicking any token row opens the **Token Details Modal** (`src/components/TokenDetailsModal.tsx`). This view allows users to analyze price history charts, timeline events (start/stop tracking), and risk metrics before trading.
  - **"Chart & Buy" (Action)**: A direct button on each row opens the **Trading Modal** (`src/components/ChartBuyModal.tsx`) for immediate trade execution.
- **State Management**: Uses `useState` for filters (search, status, sorting), pagination, and modal visibility (`selectedTokenForDetails`).

### 2. Data Fetching Layer
**Hook:** `src/hooks/useTrendingStats.ts`
**Endpoint:** `/api/trending/stats`

- **Mechanism**: Uses `React Query` to fetch data every 30 seconds (auto-refresh).
- **Data Source**: The API aggregates data from Supabase tables:
  - `trending_token_tracker`: Stores individual token data.
  - `trending_token_summary`: Stores daily performance snapshots.
- **Enhanced Data**:
  - The API now returns detailed `price_history` (JSONB) and `last_price_usd` for all tokens, enabling client-side chart rendering.
  - Calculates live statistics (Win Rate, Avg Gain, etc.) on the fly.

### 3. Token Analysis & Visualization
**Component:** `src/components/TokenDetailsModal.tsx`

A specialized modal for deep-diving into a token's performance:
- **Price History Chart**: Renders a line chart using `react-chartjs-2`, visualizing the token's price movement from tracking start to finish.
- **Performance Metrics**:
  - **Potential Upside**: Peak gain percentage.
  - **Reward Ratio (RnR)**: Calculated as `(Peak Price - Initial Price) / (Initial Price - Lowest Price)` (Upside / Max Drawdown).
- **Timeline**: Visual breakdown of "Tracking Started" (Buy) and "Tracking Stopped" (Sell) events with exact timestamps and prices.

### 4. Tracking & Trading Workflow
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

### 5. Data Persistence (Supabase)

The system uses two primary Supabase tables (environment-aware: `_dev` vs `prod`):

#### A. `trending_token_tracker`
Stores the lifecycle of each tracked token.
- **Key Fields**:
  - `token_address`, `symbol`, `name`
  - `initial_price_usd`, `last_price_usd`, `peak_price_usd`
  - `current_gain_percentage`, `peak_gain_percentage`
  - `status`: `waiting`, `tracking`, `won`, `lost`, `skipped`
  - `organic_score`, `market_cap`
  - `price_history`: JSONB array of timestamped price points.

#### B. `trending_token_summary`
Stores daily aggregated performance stats.
- **Key Fields**:
  - `period_start`, `period_end`
  - `total_tokens_tracked`, `won_tokens`, `lost_tokens`
  - `win_rate`, `avg_peak_gain`

### 6. PnL & Trade Recording
**Utility:** `src/utils/trading-tracker.ts`
**Endpoint:** `/api/trending/records`

Separate from the "trending" status, every trade (buy/sell) is recorded for Profit & Loss (PnL) analysis.

- **Dual-Write**: Trades are saved to local storage (offline cache) and sent to the backend API.
- **Bot Integration**: The `trackBotOperation` function in `track/route.ts` automatically calls `tradingTracker.trackOperation`.
- **Syncing**: The frontend listens for updates via Server-Sent Events (SSE) at `/api/trading/subscribe` to update the UI immediately after a bot trade.

### 7. Automation & Strategies

- **Bot Operations**: Located in `src/app/api/trending/track/route.ts`.
- **Logic**:
  - `trackBotOperation`: Central function to log simulated or real trades.
  - **PnL Sync**: Triggers `triggerPnLSync` to notify the UI of new trades.
  - **Discord**: Sends webhooks for significant events (New Track, Win, Loss).

## Summary of Data Flow

1.  **User/Bot** -> `POST /api/trending/track` -> **Supabase** (`trending_token_tracker`).
2.  **System** -> Executes Trade/Sim -> **PnL API** (`/api/trading/records`).
3.  **Frontend** -> `useTrendingStats` -> `GET /api/trending/stats` -> **Supabase** (with Price History).
4.  **User Interaction** -> Click Row -> **TokenDetailsModal** (Analysis) -> Click Buy -> **ChartBuyModal** (Execution).
