# 🎯 Catch the Coin - Gamified Trading Implementation

## 🎮 Overview

**Catch the Coin** is a gamified trading feature integrated into the ReloadSOL platform. It transforms trending token trading into an engaging, competitive experience where users compete to "catch" (buy) trending tokens at the optimal moment.

**Current Status**: 🚧 **In Progress / Partially Implemented**
- **Frontend**: `CatchTheCoinClient.tsx` component structure exists.
- **Backend**: Leverages existing `trending` and `buy` APIs.

## 🏆 Core Features

### 1. **Gamified Token Catching**
- **Interactive Interface**: Click-to-catch mechanism for trending tokens.
- **Visual Feedback**: Animated token "catching".
- **Integration**: Directly hooks into the `BulkTokenBuyer` logic for execution.

### 2. **Real-time Leaderboards**
- **PnL Rankings**: Top performers by profit/loss percentage.
- **Data Source**: Uses `trading_history` table in Supabase.

## 🔧 Technical Architecture

### Database Schema
Leverages the existing `tracking_history` and `operations` tables, enriched with "gamification" metadata where possible.

### UI/UX Components

#### **CatchTheCoinClient.tsx** (`src/components/CatchTheCoinClient.tsx`)
- **Function**: The main game interface.
- **Features**:
  - Fetches trending tokens via `/api/trending/stats`.
  - Displays tokens as "catchable" entities.
  - Executes buys via `BulkTokenBuyer` integration.

## 🚀 Implementation Phases

### Phase 1: Core Infrastructure (✅ Completed)
- [x] Database schema (shared with main trading app).
- [x] Buy/Exit API endpoints (`/api/buy`, `/api/trending/track`).
- [x] Trending data source (`/api/trending/stats`).

### Phase 2: Game Interface (🚧 In Progress)
- [x] `CatchTheCoinClient.tsx` basic structure.
- [ ] Real-time score updates specific to "Game Mode".
- [ ] Dedicated Leaderboard UI.

### Phase 3: Advanced Features (Planned)
- [ ] Achievement system (Badges).
- [ ] Streak bonuses.
- [ ] Social sharing.

## 🔄 Integration with Existing Features

### TrendingTokens Integration
- The "Catch" feature acts as a specialized view on top of the standard `TrendingTokens` data.
- It filters for high-momentum tokens (using `TradingSignals` logic) to present as "Targets".

### Trading Infrastructure
- **Execution**: Uses the same robust `Jupiter` integration as the main app.
- **Wallet**: Uses `PhantomWalletButton` for authentication.
- **Safety**: Inherits all risk checks (RugCheck, etc.) from the main trading engine.
