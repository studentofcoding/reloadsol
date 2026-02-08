# API Architecture Summary

Based on a comprehensive analysis of the `src/app/api` directory, this document outlines the API architecture of the application. The codebase is organized into distinct functional domains, with a heavy emphasis on **trading automation**, **real-time data**, and **performance monitoring**.

## 1. Trending & Auto-Trading Engine (`/api/trending/*`)
This is the core of the application, responsible for identifying, tracking, and trading trending tokens.

*   **`trending/track/route.ts`**: The "Brain" of the operation.
    *   **Function**: Manages the lifecycle of tracked tokens (Simulated vs. Real Trading).
    *   **Key Features**:
        *   **Dual Mode**: Supports `isSimulated` flag to switch between paper trading and real execution.
        *   **Strategy Engine**: Executes defined strategies (e.g., 'att') with specific TP/SL parameters.
        *   **Security**: Uses `TRADING_KEYPAIR_JSON` for server-side signing in real mode.
        *   **Notifications**: Sends Discord alerts (differentiating "🔥 LIVE" vs "💻 SIMULATION").
*   **`trending/route.ts`**:
    *   **Function**: Runs background auto-notifications.
    *   **Key Features**: Uses a global timer to periodically fetch fresh data and alert Discord about new trending tokens.
*   **`trending/prices/route.ts`**:
    *   **Function**: Fetches raw trending data from Jupiter APIs.
*   **`trending/stats/route.ts`**:
    *   **Function**: Provides aggregated performance statistics (winners/losers, win rates).

## 2. Trading Signals & Execution (`/api/trading/*` & `/api/buy`)
Handles signal generation and trade execution.

*   **`trading/signals/route.ts`**:
    *   **Function**: Computes actionable buy/sell signals.
    *   **Key Features**:
        *   **Scoring**: Calculates scores based on growth, recency, and speed.
        *   **Decisions**: Returns `enter`, `hold`, `exit`, `skip` recommendations.
        *   **Rug Protection**: Validates against sudden market cap drops before signaling.
*   **`buy/route.ts`**:
    *   **Function**: The primary execution endpoint for client-side bulk buys.
    *   **Key Features**: Smart routing and fee management.
*   **`trade/compare/route.ts`**:
    *   **Function**: Compares quotes across multiple providers (Jupiter, SolanaTracker, GMGN).

## 3. Real-Time Infrastructure (`src/utils/trading-tracker.ts`)
While not a single API route, this utility powers the real-time capabilities via **Server-Sent Events (SSE)**.

*   **`trading/subscribe/route.ts`** (Implied):
    *   **Function**: Establishes SSE connections for real-time updates.
    *   **Key Features**:
        *   **Health Checks**: 60s heartbeat to detect stale connections.
        *   **Debouncing**: Prevents connection storms.
        *   **Resilience**: Handles "OPEN" state errors gracefully to prevent clashing.

## 4. Analytics & Intelligence (`/api/analytics/*`)
Provides deep insights into token performance and anomalies.

*   **`analytics/anomalies/route.ts`**:
    *   **Function**: Detects market anomalies using Z-Score and Momentum analysis.
*   **`analytics/token/route.ts`**:
    *   **Function**: Deep dive enrichment for specific tokens (price, liquidity, risk scores).

## 5. Infrastructure & Monitoring
Ensures the system remains healthy and performant.

*   **`rpc/health/route.ts`**:
    *   **Function**: Monitors RPC endpoint health with Circuit Breaker pattern.
*   **`logs/stream/route.ts`**:
    *   **Function**: Streams server logs to the frontend via SSE.

## Summary of Key Patterns
1.  **Hybrid Execution**: Seamless switching between **Simulated** and **Real** trading using the same logic path in `trending/track`.
2.  **Real-Time First**: Heavy reliance on SSE for live updates (signals, trades, logs) rather than polling.
3.  **Safety & Security**:
    *   Server-side key management (`TRADING_KEYPAIR_JSON`).
    *   Rug pull protection filters.
    *   Circuit breakers for RPCs.
