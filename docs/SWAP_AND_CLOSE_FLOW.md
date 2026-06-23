# Swap and Close Operations

This document summarizes how bulk swaps and token account closures work across the project, including provider integrations, token categorization, fees, and metadata enrichment. It consolidates behavior implemented in `src/utils/jupiter.ts` and the UI flows in `src/components/BulkTokenSeller.tsx` and `src/components/BulkTokenBuyer.tsx`.

## Working Stack

| Layer | Service | Files |
|-------|---------|-------|
| Wallet tokens | Jupiter Portfolio | `useWalletTokens.ts`, `jupiter-portfolio.ts` |
| Swaps | Raptor quote-and-swap + send + status poll | `solanatracker-raptor.ts`, `/api/solanatracker/*` |
| RPC | Same-origin `/api/rpc` proxy | `RpcContext.tsx`, `/api/rpc/route.ts` |
| Prices/metadata | Jupiter APIs (UI support, not swap execution) | `/api/tokens/prices`, `/api/jupiter/metadata` |
| Charts | GMGN iframe embeds only (`gmgn.cc`) | `BulkTokenBuyer.tsx`, `BulkTokenSeller.tsx`, chart pages |
| Close accounts | On-chain burn + close via wallet | `closeTokenAccounts`, `closeZeroBalanceTokens` |

## Providers and Flow

- **Solana Tracker Raptor (bulk buy and bulk sell)**
  - Quote: `GET /api/solanatracker/quote` → Raptor `GET /quote` (amount in smallest units, `slippageBps`)
  - Swap: `POST /api/solanatracker/swap` → Raptor `POST /quote-and-swap`
  - Send: `POST /api/solanatracker/send` → Raptor `POST /send-transaction` (RPC fallback if send fails)
  - Implementation: `executeBulkSellAlt`, `executeBulkBuy` in `src/utils/jupiter.ts`
  - Close: Uses `closeTokenAccounts` after swaps or close-only operations

- **GMGN (charts only)**
  - Embedded `gmgn.cc` iframes on `/buy` and `/sell` for price charts
  - No GMGN swap execution in bulk flows

- **Jupiter swap API (other features only)**
  - `getSwapQuote` / `getSwapTransaction` remain for signals, SL/TP, trending tracker, and legacy single-token paths
  - Bulk `/buy` and `/sell` do **not** fall back to Jupiter swap execution

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
  - Missing token accounts (already closed) are treated as success.
  - Fees: Applies the fixed per-close fee via `getFeeForOperation('CLOSE')`.

## Post-Swap Closures

- After swaps: If a token is sold 100%, `closeTokenAccounts` is invoked to close the account. If a residual balance is detected, a burn instruction is added first.
- Closures use on-chain burn + close via the wallet and `/api/rpc`, regardless of which swap path was used.

## Fees

The system implements a centralized fee configuration in `src/utils/jupiter.ts`:

- **Sell Fees:** **0.5%** of the SOL received from the swap.
- **Buy Fees:** **0.5%** of the SOL budget used for the buy.
- **Close Fees:** **0.001 SOL** (fixed) per successful close operation.
- **Distribution:** All fees are currently routed to the **Dev Wallet**. The referral split is set to 0%.

## Edge Cases and Safeguards

- **Frozen tokens**: Automatically excluded from swaps and closes; added to failed lists.
- **Pump.fun tokens**: Same unified close path as other tokens — burn remaining balance if needed, then close.
- **Missing accounts**: `getAccountInfo` returns null or RPC "could not find account" → counted as already closed (success).
- **Account validation**: `closeTokenAccounts` validates account existence and data length, and re-checks frozen state from raw account data.
- **Batch mechanics**: Bulk flows sign and submit transactions in batches with retries and confirmation checks.

## Operational Guidance

- Use close-only for zero-balance or micro-value tokens (`usdValue < 0.001`) to avoid unnecessary swaps.
- After swapping valuable tokens, rely on auto-close behavior for 100% sells; otherwise, close-only can be triggered separately.
- After a 100% Raptor sell, close should succeed even if the ATA was already reclaimed.

## References

- Core logic: `src/utils/jupiter.ts` (`executeBulkSellAlt`, `executeBulkBuy`, `closeTokenAccounts`, `closeZeroBalanceTokens`, `categorizeUserTokens`, `enrichTokenMetadataAsync`).
- UI integration: `src/components/BulkTokenSeller.tsx` (`handleBulkSell`, `handleCloseOnly`), `src/components/BulkTokenBuyer.tsx` (bulk buy).
- Single token UI: `src/components/CatchTheCoinClient.tsx` (sell-only path using Jupiter).
- Swap Tracking: `src/utils/trading-tracker.ts`.

## Code References by Step

- Token Discovery & Categorization
  - `src/utils/jupiter.ts` — `fetchUserTokens`, `categorizeUserTokens`, `fetchZeroBalanceTokens`.
  - `src/components/BulkTokenSeller.tsx` — UI selection: `selectedTokens`, `selectedZeroBalanceTokens` management.

- Quote & Route Selection
  - `src/components/BulkTokenSeller.tsx` — `fetchQuoteForToken` via `/api/solanatracker/quote`; helpers `getQuoteForToken`, `isQuoteValid`.
  - `src/utils/jupiter.ts` — `executeBulkBuy` uses Raptor quote-and-swap.
  - `src/components/CatchTheCoinClient.tsx` — `fetchSellQuotes` and hover-driven quoting using `getSwapQuote`.

- Transaction Building
  - `src/utils/jupiter.ts` — `executeBulkSellAlt`, `executeBulkBuy` via Raptor `/api/solanatracker/*`.

- Fee Calculation & Attachment
  - `src/utils/jupiter.ts` — `calculateFeeDistribution`, `getFeeForOperation`, `createJupiterFeeInstructions`, `createFeeTransferInstructions`, `getFeeInfo`.
  - `src/components/CatchTheCoinClient.tsx` — Uses `createFeeTransferInstructions` inside `handleSellToken`.

- Signing, Submission & Confirmation
  - `src/utils/jupiter.ts` — `executeBulkSellAlt`, `executeBulkBuy`: batch `signAllTransactions`, Raptor send + poll, RPC fallback for send.
  - `src/components/CatchTheCoinClient.tsx` — `handleSellToken`: `signAllTransactions`, `sendRawTransaction`, `confirmTransaction`.

- Post-Swap Account Closure
  - `src/utils/jupiter.ts` — `closeTokenAccounts`: `getAccountInfo` first; missing ATA → success; burn if balance > 0, then close.
  - `src/utils/jupiter.ts` — `closeZeroBalanceTokens`: same missing-account handling; burns tiny balances then closes.
  - `src/components/BulkTokenSeller.tsx` — Auto-close after 100% sells via `executeBulkSellAlt` close path.

- Close-Only Operations
  - `src/components/BulkTokenSeller.tsx` — `handleCloseOnly`: calls `executeBulkSellAlt` with `tokens: []` and `unsellableTokens`.
  - `src/utils/jupiter.ts` — `closeZeroBalanceTokens`, `fetchZeroBalanceTokens` for identifying candidates.

- Tracking & History
  - `src/utils/trading-tracker.ts` — `trackJupiterSwap` for swap history and analytics.
  - `src/components/BulkTokenSeller.tsx` — `trackClose` invocation after close-only operations; merges close results into bulk sell results.

- Safeguards & Edge Handling
  - `src/utils/jupiter.ts` — `categorizeUserTokens` for classification; `closeTokenAccounts` for freeze checks and account validation.
  - `src/utils/jupiter.ts` — Batch construction, timeouts, and retry logic inside bulk flows.
