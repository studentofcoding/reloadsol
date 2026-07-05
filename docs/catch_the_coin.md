# 🎮 Catch the Coin & Charts Page Documentation

> **Note (Jul 2026):** Production DB is Postgres `reloadsol_db` (Docker). Supabase is no longer used. For current ops see [OPERATOR_STATE.md](./OPERATOR_STATE.md) and Pattern ML in [ARCHITECTURE_SUMMARY.md](./ARCHITECTURE_SUMMARY.md).

## Overview

This module consists of two main interfaces designed for rapid token filtering, tracking, and execution.

1.  **Catch the Coin** (`/catch-the-coin`): High-speed filtering of trending tokens.
2.  **Charts / Kanban** (`/charts`): Deep dive tracking, visualization, and bulk execution.

---

## 1. Catch the Coin Page

**Purpose**: The "Front Line" of token discovery.

### Key Features

- **Trending Feed**: Fetches real-time trending tokens from the backend.
- **Filters**:
  - **Market Cap**: Automatically filters for tokens < $300k Mcap (Sweet spot for 10-100x).
  - **Organic Score**: Prioritizes tokens with genuine volume.
- **Quick Actions**:
  - **"Keep" / Label**: Adds token to the `trading_signals` DB.
  - **Initial Price**: Captures the price at the moment of interest.

---

## 2. Charts (Kanban) Page

**Purpose**: Manage selected tokens, visualize charts, and execute trades.

### 📋 Kanban Columns

The board is divided into 3 status columns:

1.  **Watching**: Interesting tokens, waiting for a setup.
2.  **Potential**: Validated setups ready for entry.
3.  **Rugged**: Failed tokens (kept for historical analysis).

### ⚡ Execution Features

#### **A. Bulk Buy Potential**

- **Location**: Top of "Potential" column.
- **Input**: Total SOL amount (e.g., 1.0 SOL).
- **Logic**: Distributes the total SOL across all tokens in the "Potential" column using **Weighted Position Sizing** (see `strategies/overview_signals.md`).
- **Batching**: Executes swaps sequentially via Jupiter.

#### **B. Instant Buy**

- **Location**: Individual Token Card.
- **Action**: Swaps 0.1 SOL (configurable) for the specific token immediately.

#### **C. End Tracking**

- **Location**: Purple "End" button on Token Card.
- **Purpose**: Close the tracking loop and save results.
- **Process**:
  1.  **Screenshot**: Uses `html2canvas` to take a picture of the card state.
  2.  **PnL Calculation**: `((Current Price - Initial Price) / Initial Price) * 100`.
  3.  **Archival**: Saves the JSON result and Image Base64 to Postgres.

---

## 🔧 Technical Implementation Details

### Database Interaction

- **Table**: `trading_signals`
- **API Route**: `/api/signals`
  - `GET`: Retrieves active signals for the board.
  - `POST`: Creates/Updates signals, handles "End Tracking" data blob.

### Frontend Libraries

- **Drag & Drop**: `@dnd-kit/core` for moving cards between columns.
- **Charts**: Embedded `gmgn.cc` iFrames.
- **Screenshots**: `html2canvas` (with CORS configuration).
- **State Management**: React `useState` + Optimistic UI updates.

### Usage Flow

1.  **Spot** a token on "Catch the Coin".
2.  **Label** it -> Moves to "Watching" on Charts Page.
3.  **Analyze** chart on Charts Page.
4.  **Drag** to "Potential" if it looks good.
5.  **Click** "Buy Potential" to enter positions.
6.  **Monitor** trade.
7.  **Click** "End" when trade is finished (profit or loss) to save record.
