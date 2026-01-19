# API Architecture Summary

Based on a comprehensive analysis of the `src/app/api` directory, this document outlines the API architecture of the application. The codebase is organized into distinct functional domains, with a heavy emphasis on **trading automation**, **data aggregation**, and **performance monitoring**.

## 1. Trending & Auto-Trading Engine (`/api/trending/*`)
This is the core of the application, responsible for identifying, tracking, and trading trending tokens.

*   **`trending/track/route.ts`**: The "Brain" of the operation.
    *   **Function**: Manages the lifecycle of tracked tokens (Simulated vs. Real Trading).
    *   **Key Features**: 
        *   Handles `PUT` requests to enable/disable tracking.
        *   Executes risk assessments (RugCheck, liquidity analysis).
        *   Creates Stop-Loss/Take-Profit (SL/TP) positions.
        *   Sends Discord notifications (differentiating between "🔥 LIVE" and "💻 SIMULATION").
*   **`trending/route.ts`**:
    *   **Function**: Runs background auto-notifications.
    *   **Key Features**: Uses a global timer to periodically fetch fresh data and alert Discord about new trending tokens.
*   **`trending/prices/route.ts`** & **`trending/volume-1h-buyers-1000/route.ts`**:
    *   **Function**: Fetches raw trending data from Jupiter APIs.
    *   **Key Features**: Filters out tokens with extreme drops (>40%) to prevent buying falling knives.
*   **`trending/history/route.ts`** & **`trending/stats/route.ts`**:
    *   **Function**: Provides historical performance data and aggregate statistics (winners/losers) for the frontend dashboard.
*   **`trending/summary/route.ts`**:
    *   **Function**: Generates 24-hour performance summaries (often triggered by Cron jobs).

## 2. Trading Operations (`/api/trade/*` & `/api/buy`)
Handles the execution and analysis of trades.

*   **`buy/route.ts`**:
    *   **Function**: The primary execution endpoint.
    *   **Key Features**:
        *   **Smart Routing**: Can return an unsigned transaction for the client OR broadcast a signed transaction directly via Helius.
        *   **Fee Management**: Configures priority fees and compute unit limits.
*   **`trade/compare/route.ts`** & **`enhanced-compare/route.ts`**:
    *   **Function**: Compares quotes across multiple providers (Jupiter, SolanaTracker, GMGN).
    *   **Key Features**: Implements caching to reduce API calls and latency. The "enhanced" version runs multiple scenarios to find the optimal route.
*   **`trade/health/route.ts`**:
    *   **Function**: Monitors the uptime of upstream trading providers (Jupiter, etc.).

## 3. Analytics & Intelligence (`/api/analytics/*`)
Provides deep insights into token performance and anomalies.

*   **`analytics/anomalies/route.ts`**:
    *   **Function**: Runs complex algorithms to detect market anomalies.
    *   **Logic**: Uses Z-Score (statistical outlier detection), Momentum analysis (MACD/RSI), and Liquidity checks to flag unusual token behavior.
*   **`analytics/token/route.ts`**:
    *   **Function**: On-demand deep dive for specific tokens (supports batching up to 100 tokens).

## 4. Data Providers & Proxies (`/api/providers/*` & `/api/tokens/*`)
Acts as a middleware layer to external APIs, adding caching and rate limiting.

*   **`tokens/prices/route.ts`**:
    *   **Function**: Batched price fetcher.
    *   **Optimization**: Uses tiered caching—popular tokens (SOL, USDC) are cached longer (5m) than volatile meme coins (2m).
*   **`axiom/token-info/route.ts`**:
    *   **Function**: Proxies requests to Axiom for token metadata, handling their specific auth/cookie requirements.
*   **`jupiter/metadata/route.ts`**:
    *   **Function**: Server-side cache (31 days) for Jupiter token metadata to minimize external calls.

## 5. Infrastructure & Monitoring
Ensures the system remains healthy and performant.

*   **`rpc/health/route.ts`** & **`rpc/config/route.ts`**:
    *   **Function**: Monitors RPC endpoint health.
    *   **Key Features**: Implements a "Circuit Breaker" pattern—automatically routing away from unhealthy RPC nodes.
*   **`logs/stream/route.ts`**:
    *   **Function**: Streams server logs to the frontend via Server-Sent Events (SSE) for real-time debugging.
*   **`health/route.ts`**:
    *   **Function**: Simple heartbeat returning uptime and memory usage.

## 6. User Operations (`/api/operations/*`)
Manages user-specific data and gamification.

*   **`operations/points/route.ts`**:
    *   **Function**: Calculates user points based on trading activity (Swaps = 10pts, Closes = 5pts).
*   **`operations/sync/route.ts`**:
    *   **Function**: Syncs local client state (like wallet balances and operation counts) to the Supabase database atomically.

## Summary of Key Patterns
1.  **Aggressive Caching**: Almost every read-heavy endpoint (`prices`, `metadata`, `health`) implements in-memory caching with Time-To-Live (TTL) to protect against rate limits.
2.  **Atomic Updates**: Database writes (like `operations/track`) use atomic SQL operations or RPC calls to prevent race conditions during high-frequency trading.
3.  **Hybrid Execution**: The system supports both **Simulated** (paper trading) and **Real** trading modes using the same underlying logic, switched via a simple flag.
4.  **Resilience**: Critical paths (like buying and RPC calls) have fallback mechanisms and health checks to ensure reliability.
