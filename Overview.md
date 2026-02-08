# ReloadSOL Application Overview

**ReloadSOL** is a comprehensive Solana trading dashboard focused on bulk operations, profit tracking, and market analysis. It allows users to efficiently manage their portfolios by buying and selling tokens in bulk, tracking profit and loss, and analyzing market trends.

## 1. Core Trading Features

### Bulk Token Buying (`/buy`)

- **Functionality**: Buy up to 10 tokens simultaneously with a single SOL amount split across them.
- **Risk Analysis**: Integrated risk checks ([RiskAnalysis.tsx](src/components/RiskAnalysis.tsx)) to evaluate token safety before purchase.
- **Providers**: Supports multiple DEX aggregators including **Jupiter**, **SolanaTracker**, and **GMGN**.
- **Key Component**: [BulkTokenBuyer.tsx](src/components/BulkTokenBuyer.tsx)

### Bulk Token Selling & Reloading (`/sell`)

- **Functionality**: Sell multiple tokens at once to "reload" SOL.
- **Dust Sweeping**: Automatically identifies and closes empty token accounts to reclaim rent (approx. 0.002 SOL per account).
- **PnL Sharing**: Generate shareable images of trading performance.
- **Key Component**: [BulkTokenSeller.tsx](src/components/BulkTokenSeller.tsx)

### Swap Interface (`/swap`)

- **Functionality**: A dedicated interface for single-token swaps.
- **Key Component**: [SwapPageClient.tsx](<src/app/(trade)/swap/SwapPageClient.tsx>)

## 2. Tracking & Analytics

### PnL Tracker

- **Functionality**: Tracks **Open Positions** (current holdings) and **Completed Trades** (historical).
- **Metrics**: Calculates Realized/Unrealized PnL in SOL and USD.
- **Integration**: Handles both manual trades and bot operations.
- **Key Component**: [PnLTracker.tsx](src/components/PnLTracker.tsx)

### Market Cap (MCap) Tracker (`/dev/mcap-tracker`)

- **Functionality**: Monitors token growth milestones (e.g., reaching 80%, 120%, 200% of initial MCap).
- **Analytics**: Includes anomaly detection and momentum scoring.
- **Key Component**: [page.tsx](src/app/dev/mcap-tracker/page.tsx)

### Trending Tracker (`/dev/trending-tracker`)

- **Functionality**: Tracks "trending" tokens and classifies them as **Won** (hit targets), **Lost**, or **Tracking**.
- **Metrics**: Calculates win rates and performance statistics.
- **User Experience**: Integrated [ChartBuyModal.tsx](src/components/ChartBuyModal.tsx) with keyboard navigation (Up/Down arrows) for rapid token switching.
- **Key Component**: [page.tsx](src/app/dev/trending-tracker/page.tsx)

### Trading Signals (`/dev/signals`)

- **Functionality**: Surfaces actionable signals based on strategies (e.g., "sell_over_100").
- **Visualization**: Features **Floating Charts** to monitor multiple tokens simultaneously.
- **User Experience**: Seamless integration of [ChartBuyModal.tsx](src/components/ChartBuyModal.tsx) for quick buy execution from signals.
- **Key Component**: [TradingSignals.tsx](src/components/TradingSignals.tsx)

## 3. Gamification & Engagement

### Catch the Coin

- **Functionality**: A fast-paced feature to "catch" (buy) trending tokens instantly.
- **Key Component**: [CatchTheCoinClient.tsx](src/components/CatchTheCoinClient.tsx)

### User Engagement

- **Daily Streak**: Tracks consecutive days of activity ([useDailyStreak.ts](src/hooks/useDailyStreak.ts)).
- **Wallet Points**: Rewards system for platform usage.

## 4. Infrastructure & Integration

- **Wallet**: Deep integration with **Phantom** wallet for connection and signing ([PhantomWalletButton.tsx](src/components/PhantomWalletButton.tsx)).
- **Real-time Data**: Robust **Server-Sent Events (SSE)** infrastructure ([trading-tracker.ts](src/utils/trading-tracker.ts)) with:
  - Automatic health checks and reconnection logic.
  - Intelligent error handling for transient states (preventing "clashing" connections).
  - Exponential backoff for reliability.
- **Data Providers**: Uses **Jupiter API** for swaps/pricing and **Supabase** (via API routes) for storing tracking data.
- **Dev Tools**: A suite of developer tools under `src/app/dev/` for internal monitoring and testing.
