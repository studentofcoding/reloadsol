# Swap and Close Operations

This document summarizes how bulk swaps and token account closures work across the project, including provider integrations, token categorization, fees, and metadata enrichment. It consolidates behavior implemented in `src/utils/jupiter.ts` and the UI flows in `src/components/BulkTokenSeller.tsx` and `src/components/CatchTheCoinClient.tsx`.

## Providers and Flow

- **Jupiter (default)**
  - Quote/Swap: `getSwapQuote`, `getSwapTransaction`, `executeBulkSell`.
  - Close: Centralized via `closeTokenAccounts` and `closeZeroBalanceTokens`.
  - Fees: Percentage-based for `SELL`, fixed per-close for `CLOSE` using `createJupiterFeeInstructions` / `createFeeTransferInstructions` and `getFeeForOperation('CLOSE')`.

- **Solana-Tracker (alt path)**
  - Swap: `executeBulkSellAlt` posting to `https://swap-v2.solanatracker.io/swap`.
  - Close: Still uses Jupiter’s `closeTokenAccounts` for closures after swaps or close-only operations.

- **GMGN (custom provider)**
  - Swap: Provider-specific quote and submission handled in `BulkTokenSeller.tsx`.
  - Close: After GMGN swaps, tokens sold 100% are auto-closed via Jupiter’s `closeTokenAccounts`. Unsellable selections are closed through the same Jupiter close path.

- **Single-token UI**
  - `CatchTheCoinClient.tsx` sells via Jupiter utilities (quote + swap) but does not auto-close the token account after selling. Closing is handled in bulk flows.

## Token Categorization

Defined in `categorizeUserTokens` (`src/utils/jupiter.ts`):

- `sellable`: Tokens where `usdValue >= 0.001` or flagged as sellable (e.g., Pump.fun categorization for quoting).
- `unsellable`: Non-zero balance tokens with `usdValue < 0.001` and other constraints.
- `zeroBalance`: `uiAmount <= 0.000000000001`.
- `frozen`: Tokens flagged as frozen are excluded from both swaps and closes.
- `nfts`: Tokens identified as NFTs.

## Metadata Enrichment

Implemented in `enrichTokenMetadataAsync` (`src/utils/jupiter.ts`), the system enriches token metadata (symbol, name, logo) without blocking the main UI or swap flows.

- **Behavior:**
  - Asynchronous and non-blocking: The UI loads tokens immediately with "Unknown" placeholders, and metadata populates as it becomes available.
  - **Batching:** Processes tokens in batches of **10** to respect API rate limits.
  - **Throttling:** Adds a **500ms** delay between batches.
  - **Caching:** Enriched metadata is cached in `tokenCache` to prevent redundant fetches.
  - **Triggers:** Automatically triggered after `fetchUserTokens` completes its initial pass.

## Close-Only Operations

- Entry points: `handleCloseOnly` in `BulkTokenSeller.tsx` and `closeZeroBalanceTokens` in `src/utils/jupiter.ts`.
- Behavior:
  - If a token account has a positive balance but `usdValue < 0.001`, the flow creates a burn instruction first (burn entire balance), then closes the account.
  - Frozen tokens are skipped and recorded as failed closes.
  - Pump.fun tokens: if any positive balance exists, closure is blocked and recorded as failed (safeguard).
  - Fees: Applies the fixed per-close fee via `getFeeForOperation('CLOSE')`.

## Post-Swap Closures

- After swaps: If a token is sold 100%, `closeTokenAccounts` is invoked to close the account. If a residual balance is detected, a burn instruction is added first.
- Provider-agnostic: Regardless of swap provider (Jupiter, Solana-Tracker, GMGN), closures are executed via Jupiter’s `closeTokenAccounts` for consistent safeguards and fee handling.

## Fees

The system implements a centralized fee configuration in `src/utils/jupiter.ts`:

- **Sell Fees:** **0.5%** of the SOL received from the swap.
- **Buy Fees:** **0.5%** of the SOL budget used for the buy.
- **Close Fees:** **0.001 SOL** (fixed) per successful close operation.
- **Distribution:** All fees are currently routed to the **Dev Wallet**. The referral split is set to 0%.

## Edge Cases and Safeguards

- **Frozen tokens**: Automatically excluded from swaps and closes; added to failed lists.
- **Pump.fun tokens**: Treated carefully—quotes/swaps allowed, but closure blocked if any positive balance remains.
- **Account validation**: `closeTokenAccounts` validates account existence and data length, and re-checks frozen state from raw account data.
- **Batch mechanics**: Bulk flows sign and submit transactions in batches with retries and confirmation checks.

## Operational Guidance

- Use close-only for zero-balance or micro-value tokens (`usdValue < 0.001`) to avoid unnecessary swaps.
- Prefer Jupiter for closures to retain safeguards and consistent fee handling.
- After swapping valuable tokens, rely on auto-close behavior for 100% sells; otherwise, close-only can be triggered separately.

## References

- Core logic: `src/utils/jupiter.ts` (`executeBulkSell`, `executeBulkSellAlt`, `closeTokenAccounts`, `closeZeroBalanceTokens`, `categorizeUserTokens`, `enrichTokenMetadataAsync`).
- UI integration: `src/components/BulkTokenSeller.tsx` (`handleBulkSell`, `handleCloseOnly`, GMGN batch handling and auto-close). 
- Single token UI: `src/components/CatchTheCoinClient.tsx` (sell-only path using Jupiter).
- Swap Tracking: `src/utils/trading-tracker.ts`.

## Code References by Step

- Token Discovery & Categorization
  - `src/utils/jupiter.ts` — `fetchUserTokens`, `categorizeUserTokens`, `fetchZeroBalanceTokens`.
  - `src/components/BulkTokenSeller.tsx` — UI selection: `selectedTokens`, `selectedZeroBalanceTokens` management.

- Quote & Route Selection
  - `src/utils/jupiter.ts` — `getSwapQuote` (Jupiter `/v6/quote`).
  - `src/components/BulkTokenSeller.tsx` — `tryProvider` → `fetchJupiterQuote` | `fetchGMGNQuote`; helpers `getQuoteForToken`, `isQuoteValid`.
  - `src/components/CatchTheCoinClient.tsx` — `fetchSellQuotes` and hover-driven quoting using `getSwapQuote`.

- Transaction Building
  - `src/utils/jupiter.ts` — `getSwapTransaction` (Jupiter `/v6/swap`).
  - `src/utils/jupiter.ts` — `executeBulkSellAlt` → POST to `https://swap-v2.solanatracker.io/swap` to build transactions.
  - `src/components/BulkTokenSeller.tsx` — GMGN path: `executeCustomSwap`; deserialize `quote.route.data.raw_tx.swapTransaction` into `VersionedTransaction`.

- Fee Calculation & Attachment
  - `src/utils/jupiter.ts` — `calculateFeeDistribution`, `getFeeForOperation`, `createJupiterFeeInstructions`, `createFeeTransferInstructions`, `getFeeInfo`.
  - `src/components/CatchTheCoinClient.tsx` — Uses `createFeeTransferInstructions` inside `handleSellToken`.

- Signing, Submission & Confirmation
  - `src/utils/jupiter.ts` — `executeBulkSell`, `executeBulkSellAlt`: batch `signAllTransactions`, send via `connection`, confirm with retries.
  - `src/components/BulkTokenSeller.tsx` — GMGN batch: `signAllTransactions` then submit to `/api/providers/gmgn/submit`.
  - `src/components/CatchTheCoinClient.tsx` — `handleSellToken`: `signAllTransactions`, `sendRawTransaction`, `confirmTransaction`.

- Post-Swap Account Closure
  - `src/utils/jupiter.ts` — `closeTokenAccounts`: creates `burnInstruction` if balance > 0, then `closeAccountInstruction`; skips frozen and problematic (e.g., Pump.fun with balance).
  - `src/utils/jupiter.ts` — `closeZeroBalanceTokens`: burns tiny balances then closes; excludes frozen and Pump.fun with balance.
  - `src/components/BulkTokenSeller.tsx` — Auto-close after GMGN swaps (100% sells): invokes `executeBulkSellAlt` with `unsellableTokens` for closure.

- Close-Only Operations
  - `src/components/BulkTokenSeller.tsx` — `handleCloseOnly`: calls `executeBulkSellAlt` with `tokens: []` and `unsellableTokens`.
  - `src/utils/jupiter.ts` — `closeZeroBalanceTokens`, `fetchZeroBalanceTokens` for identifying candidates.

- Tracking & History
  - `src/utils/trading-tracker.ts` — `trackJupiterSwap` for swap history and analytics.
  - `src/components/BulkTokenSeller.tsx` — `trackClose` invocation after close-only operations; merges close results into bulk sell results.

- Safeguards & Edge Handling
  - `src/utils/jupiter.ts` — `categorizeUserTokens` for classification; `closeTokenAccounts` for freeze checks, account validation, and Pump.fun handling.
  - `src/utils/jupiter.ts` — Batch construction, timeouts, and retry logic inside bulk flows.
