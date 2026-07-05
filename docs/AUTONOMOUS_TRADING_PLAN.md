# Autonomous Trading System Requirements & Status

> **Note (Jul 2026):** Production DB is Postgres `reloadsol_db` (Docker). Supabase is no longer used. For current ops see [OPERATOR_STATE.md](./OPERATOR_STATE.md) and Pattern ML in [ARCHITECTURE_SUMMARY.md](./ARCHITECTURE_SUMMARY.md).

## 1. Core Trading Engine

- [x] **Strategy Manager**: A modular system to load and execute different trading strategies.
  - _Implemented Strategies_:
    - **Attention Strategy (`att`)**: Aggressive profit taking (TP1: 45%, TP2: 100%).
    - **Sell Over 100**: Logic embedded in signals API.
- [x] **Position Manager**: Tracks active trades, entry prices, SL/TP targets, and realized PnL.
  - _Status_: Fully handled by `PnLTracker` and `trading-tracker.ts`.
- [x] **Risk Engine**:
  - [x] Enforces max drawdown limits (Stop Loss at -50% or custom).
  - [x] **Rug Pull Protection**: Checks for >60% sudden drops before signal generation.
  - [x] **Dynamic Stop Loss**: Configurable per strategy.

## 2. Execution Layer

- [x] **Smart Router Integration**: Uses Jupiter API for best execution.
- [x] **Priority Fee Estimator**: Configurable priority fees (default 30000 lamports) and compute unit limits.
- [x] **Transaction Monitor**: Real-time tracking via SSE (`trading-tracker.ts`) and Helius integration.

## 3. Data & Signals

- [x] **Signal Aggregator**:
  - [x] **Technical Analysis**: Z-Score, Momentum/MACD.
  - [x] **Scoring Engine**: Recency, Growth Speed, Thresholds (`src/app/api/trading/signals/route.ts`).
  - [x] **Market Structure**: MCap Bucket Performance.
- [ ] **Social Sentiment**: Twitter/Discord volume (Future).
- [ ] **Backtesting Engine**: Simulate strategies against historical data (Partially covered by "Simulation Mode").

## 4. Infrastructure

- [x] **Wallet Management**:
  - [x] **Simulation**: Virtual wallet tracking.
  - [x] **Real Trading**: `TRADING_KEYPAIR_JSON` env var for secure server-side signing.
- [x] **State Persistence**: Postgres `reloadsol_db` (`trending_token_tracker`, `trading_history`).
- [x] **Failover Mechanisms**:
  - [x] **RPC Health**: Circuit breaker pattern implemented.
  - [x] **Data Provider**: Fallback logic for price fetches.

## 5. Monitoring & Control

- [x] **Dashboard**: Real-time view of active trades (`/dev/trending-tracker`, `/dev/signals`).
- [x] **Control**: Toggle between Simulation and Real Trading via UI/API.
- [x] **Alerting**: Discord notifications for "🔥 LIVE" and "💻 SIMULATION" trades.
- [x] **Kill Switch**: Manual stop/pause capability via API.

## 6. Current Implementation Analysis

The autonomous system is **largely operational**.

### Key Components Live:
- **`src/app/api/trending/track/route.ts`**: The "Brain" handling lifecycle, simulation/real switching, and strategy execution.
- **`src/utils/trading-tracker.ts`**: The "Heart" handling real-time SSE updates, connection health, and position tracking.
- **`src/app/api/trading/signals/route.ts`**: The "Eyes" filtering tokens and generating actionable signals.

### Strategy Implementation (`src/app/api/trending/track/route.ts`)
- **Config**: `TRADING_STRATEGIES` object defines parameters (TP levels, SL %, fees).
- **Execution**: `executeBuyOperationWithStrategy` handles the logic.

## 7. Next Steps

1.  **Refine Strategies**: Add more strategy templates beyond 'att'.
2.  **Backtesting**: Build a dedicated backtester using captured price history.
3.  **Social Signals**: Integrate Twitter/Discord sentiment analysis.
