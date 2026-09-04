# Strategy Implementation Plan: Algo Attribution & Shadow Portfolio

> **Note (Jul 2026):** Production DB is Postgres `reloadsol_db` (Docker). Supabase is no longer used. For current ops see [OPERATOR_STATE.md](./OPERATOR_STATE.md) and Pattern ML in [ARCHITECTURE_SUMMARY.md](./ARCHITECTURE_SUMMARY.md).

## Goal
To transition **ReloadSOL** from a manual/bulk execution tool into an algorithm-verified trading system. This plan involves tagging trades by their source (Manual vs. Algo) and creating a "Shadow Portfolio" to test strategies without risking capital.

---

## 1. Database & Type Definitions (Schema Update)

**Objective:** Persist the *intent* behind every trade to calculate specific performance metrics later.

### 1.1 Update `Trade` Interface
Modify your main types file (likely in `src/types/index.ts`) to include attribution fields.

```typescript
// src/types/index.ts

export type TradeSource = 'manual' | 'signal' | 'trending_tracker' | 'catch_the_coin';

export type StrategyTag = 
  | 'manual_override'      // Standard /buy
  | 'trend_breakout'       // From Trending Tracker
  | 'mcap_milestone'       // From MCap Tracker
  | 'signal_sell_over_100' // From Trading Signals
  | 'quick_catch';         // From Catch the Coin

export interface Trade {
  // Existing fields: mint, amount, price, etc.
  source: TradeSource;     // WHERE the trade originated
  strategy_tag: StrategyTag; // WHY the trade was made
  is_simulation: boolean;    // TRUE = Paper Trade, FALSE = Real SOL
  
  // Snapshot data for analysis
  entry_mcap?: number;     
  risk_score?: number;     
}
```

### 1.2 Postgres schema

Apply via [`db/init/`](../db/init/) or `bash scripts/deploy-tencent.sh schema`.
Run a migration to add these columns to your existing trades table.

```sql
ALTER TABLE trades 
ADD COLUMN source TEXT DEFAULT 'manual',
ADD COLUMN strategy_tag TEXT DEFAULT 'manual_override',
ADD COLUMN is_simulation BOOLEAN DEFAULT FALSE,
ADD COLUMN entry_mcap NUMERIC,
ADD COLUMN risk_score NUMERIC;
```

---

## 2. Execution Component Refactoring

**Objective:** Ensure that every "Buy" action passes the correct tags down to the blockchain execution layer.

### 2.1 Update `BulkTokenBuyer.tsx` [cite: Overview.md]
Update the component to accept context.

```typescript
// src/components/BulkTokenBuyer.tsx update

interface BulkBuyProps {
  // ... existing props
  defaultStrategy?: StrategyTag;
}

const executeBuy = async (
  tokens: Token[], 
  amount: number, 
  strategy: StrategyTag = 'manual_override'
) => {
  // 1. Perform Risk Analysis (RiskAnalysis.tsx) [cite: Overview.md]
  const risk = await analyzeRisk(tokens); 

  // 2. Execute Transaction via Jupiter/SolanaTracker [cite: Overview.md]
  const txSignature = await wallet.signAndSend(...);

  // 3. Save to Database with Tags
  await supabase.from('trades').insert({
    source: strategy === 'manual_override' ? 'manual' : 'signal',
    strategy_tag: strategy,
    risk_score: risk.score,
    is_simulation: false 
  });
};
```

### 2.2 Update `ChartBuyModal.tsx` [cite: Overview.md]
Pass the `strategy_tag` from parent components (Signal/Tracker) into the `BulkTokenBuyer`.

---

## 3. Signal Integration (Source Attribution)

**Objective:** Wire up trackers to pass the correct tags.

* **`TradingSignals.tsx`**: Tag signals like "sell_over_100" [cite: Overview.md].
* **`Trending Tracker`**: Tag as `trend_early_entry` for tracking tokens [cite: Overview.md].
* **`MCap Tracker`**: Tag as `mcap_milestone` when growth targets are hit [cite: Overview.md].

---

## 4. Shadow Portfolio (Simulation Engine)

**Objective:** Test strategies without spending SOL.

### 4.1 New Hook: `usePaperTrading.ts`
Create a hook to simulate execution.

```typescript
// src/hooks/usePaperTrading.ts

export const usePaperTrading = () => {
  const recordSimulatedBuy = async (token: Token, strategy: StrategyTag) => {
    const price = await getPrice(token.mint);
    
    await supabase.from('trades').insert({
      mint: token.mint,
      entry_price: price,
      amount: 1, // Normalized 1 SOL for testing
      strategy_tag: strategy,
      is_simulation: true,
      status: 'OPEN'
    });
  };

  return { recordSimulatedBuy };
};
```

---

## 5. Analytics Dashboard (`PnLTracker` Upgrade) [cite: Overview.md]

**Objective:** Visualize "Real" vs. "Algo" performance.

### 5.1 Update `PnLTracker.tsx`
* **Filters**: Add a toggle for `Show Simulations` and a dropdown for `StrategyTag`.
* **Metrics**: Calculate Win Rate % and Expectancy separately for each strategy.

---

## 6. Development Checklist

1.  [ ] **DB**: Apply schema via `db/init/` or deploy script.
2.  [ ] **Core**: Update `BulkTokenBuyer` to accept tags.
3.  [ ] **UI**: Update `ChartBuyModal` for `activeStrategy`.
4.  [ ] **Feature**: Build `usePaperTrading` hook.
5.  [ ] **Analytics**: Refactor `PnLTracker` to separate Real vs. Sim data.
