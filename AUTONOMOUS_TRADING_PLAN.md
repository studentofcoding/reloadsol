# Autonomous Trading System Requirements

## 1. Core Trading Engine

- [ ] **Strategy Manager**: A modular system to load and execute different trading strategies.
  - _Potential Strategies_:
    - **Momentum Breakout**: Utilize `EnhancedMomentumAnalyzer` (MACD crossover + acceleration).
    - **Anomaly Sniping**: Trigger buys on positive Z-Score spikes (> 2.5) from `ZScoreAnomalyDetector`.
    - **Bucket Rotation**: Focus capital on MCap ranges with highest recent win rates (from `mcapRangeAnalysis`).
- [ ] **Position Manager**: Tracks active trades, entry prices, SL/TP targets, and realized PnL.
- [ ] **Risk Engine**:
  - Enforces max drawdown limits (e.g., stop trading if daily loss > 5%).
  - Manages position sizing (e.g., max 1 SOL per trade).
  - **Dynamic Stop Loss**: Set initial SL based on the `avgDrawdown` of the token's current MCap bucket.
  - Checks for "Rug Pull" signals before buying.

## 2. Execution Layer

- [ ] **Smart Router Integration**: Fully utilize Jupiter/Raydium/GMGN APIs for best execution.
- [ ] **Priority Fee Estimator**: Dynamic fee adjustment based on network congestion to ensure transaction success.
- [ ] **Transaction Monitor**: Real-time tracking of pending transactions with auto-retry logic.

## 3. Data & Signals

- [ ] **Signal Aggregator**: Combine signals from:
  - **Technical Analysis**:
    - Z-Score Anomalies (Vol/MCap spikes) - _Ready (`src/utils/algo/anomaly-detection.ts`)_.
    - Momentum/MACD Signals - _Ready (`src/utils/algo/momentum-analysis.ts`)_.
  - **Market Structure**:
    - MCap Bucket Performance (Win% & Avg Multiplier per range) - _Ready (`src/app/dev/mcap-tracker/page.tsx`)_.
  - **Social Sentiment**: Twitter/Discord volume.
  - **On-chain Data**: Whale movements, fresh wallet funding.
- [ ] **Backtesting Engine**: Simulate strategies against historical data (`token_ohlc_bars`) to verify profitability before live deployment.

## 4. Infrastructure

- [ ] **Wallet Management**: Secure key storage (e.g., AWS KMS or encrypted local env) for the trading bot.
- [ ] **State Persistence**: Robust database schema for `active_positions`, `trade_history`, and `bot_state` (to survive restarts).
- [ ] **Failover Mechanisms**: Redundant RPC endpoints and error handling for API outages.

## 5. Monitoring & Control

- [ ] **Dashboard**: Real-time view of active trades, PnL, and bot status (Running/Paused).
- [ ] **Kill Switch**: Immediate "Panic Sell All" or "Pause Trading" button.
- [ ] **Alerting**: Instant notifications (Discord/Telegram) for trade execution, errors, and PnL milestones.

## 6. Current Implementation Analysis (Source: `src/app/dev/mcap-tracker/`)

The following components are already implemented and should be lifted into the autonomous system:

### A. Anomaly Detection (`src/utils/algo/anomaly-detection.ts`)

- **Mechanism**: Rolling window (n=50) Z-Score calculation on Market Cap.
- **Signal**: Flags tokens with `|Z-Score| > 2.5`.
- **Usage**: Use as a trigger for "Unusual Activity" entry signal.

### B. Momentum Analysis (`src/utils/algo/momentum-analysis.ts`)

- **Mechanism**: Enhanced MACD (12, 26, 9) with histogram acceleration logic.
- **Signals**: `bullish_breakout`, `bearish_breakout`, `momentum_acceleration`.
- **Usage**: Confirmation signal for trend-following strategies.

### C. Market Cap Bucketing (`src/app/dev/mcap-tracker/page.tsx`)

- **Mechanism**: Segments tokens into MCap ranges (e.g., <50k, 50k-100k, 100k-200k).
- **Metrics per Bucket**:
  - Win Rate (`winPct`)
  - Average Multiplier
  - Maximum Drawdown
  - Stop Loss Hit Rate
- **Usage**:
  - **Regime Filtering**: Only trade in buckets where `Win Rate > 50%` and `Avg Multiplier > 1.2x`.
  - **Risk Management**: Set dynamic Stop Losses based on the `maxDrawdown` statistics of the specific bucket.
