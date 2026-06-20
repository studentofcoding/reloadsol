# Signals & Trading Strategy Overview

## 🎯 Core Objective

The goal is to identify high-potential early-stage Solana tokens (low market cap), track their performance, and execute weighted bulk buys on the most promising candidates.

## 📊 Data Structure: `trading_signals`

All signal data is stored in the Supabase `trading_signals` table.

| Field             | Type      | Description                               |
| ----------------- | --------- | ----------------------------------------- |
| `id`              | uuid      | Unique identifier                         |
| `token_address`   | text      | Solana Mint Address (Unique)              |
| `token_symbol`    | text      | Token Ticker (e.g., "PEPE")               |
| `label`           | text      | Status: `watching`, `potential`, `rugged` |
| `market_cap`      | numeric   | Market Cap at time of update              |
| `price`           | numeric   | Current Price                             |
| `initial_price`   | numeric   | Price at moment of tracking/labeling      |
| `result`          | jsonb     | Final outcome data (PnL, timestamps)      |
| `image_reference` | text      | Base64 Screenshot of the chart at end     |
| `created_at`      | timestamp | Record creation time                      |
| `updated_at`      | timestamp | Last update time                          |

## 🚫 Shared rug registry: `token_rug_list`

Manual rug marks use a **single shared table** across DLMM, Signals (Board/Live/Tracker), and Algo Tester.

| Field           | Type      | Description                                      |
| --------------- | --------- | ------------------------------------------------ |
| `token_address` | text      | Solana mint (unique)                             |
| `token_symbol`  | text      | Ticker                                           |
| `source`        | text      | Where marked (`live`, `board`, `tracker`, etc.)  |
| `added_at`      | timestamp | When added to rug list                           |

- **API**: `GET/POST/DELETE` `/api/rug` (canonical); `/api/dlmm/rug` is an alias.
- **Sync**: marking rugged also updates `trading_signals.label` and `token_mcap_tracking.label` when those rows exist.
- **Exclusion**: rugged tokens are hidden from DLMM Hunter lists, the trading signals feed, and Board Watching/Potential columns.

## 🔄 Signal Lifecycle

1.  **Discovery**:
    - Tokens are detected via the Trending API (filtered for Mcap < $300k).
    - Displayed on the **Catch the Coin** page.

2.  **Labeling & Tracking**:
    - **Action**: User moves token to "Watching" or "Potential".
    - **System**: Creates a `trading_signals` record.
    - **Initial Price**: The `initial_price` is locked in at this moment to serve as the baseline for PnL calculations.

3.  **Execution (Bulk Buy)**:
    - **Target**: Tokens in the **Potential** column.
    - **Method**: Weighted distribution (see below).
    - **Tool**: Jupiter Swap API.

4.  **Resolution (End Tracking)**:
    - **Action**: User clicks "End" on the Charts page.
    - **System**:
      1.  Captures visual snapshot (html2canvas).
      2.  Fetches final price.
      3.  Calculates PnL %.
      4.  Updates DB with `result` JSON and `image_reference`.

## ⚖️ Position Sizing Strategy

When executing a **Bulk Buy** on the "Potential" column, SOL is allocated based on Market Cap risk tiers.

**Logic:** `src/utils/position-sizing.ts`

| Market Cap       | Weight Score | Rationale                              |
| ---------------- | ------------ | -------------------------------------- |
| **< $50k**       | `0.35`       | Higher risk, smaller allocation.       |
| **$50k - $100k** | `0.50`       | Standard risk, medium allocation.      |
| **> $100k**      | `0.65`       | Validated traction, higher allocation. |

**Formula:**

1.  Calculate Score for each token.
2.  `Total Score` = Sum of all scores.
3.  `Token Allocation` = `(Token Score / Total Score) * Total SOL Input`.

---

## 🛠 Tech Stack

- **Database**: Supabase (PostgreSQL)
- **API**: Next.js App Router (`/api/signals`)
- **Execution**: Jupiter V6 Swap API
- **Visualization**: GMGN.cc Charts (iFrame) + HTML2Canvas (Screenshots)
